import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { EvictionLimits } from "./context.js";
import { buildEvictionHook } from "./context.js";

import { SystemMessage } from "@langchain/core/messages";

export interface AgentDeps {
  readonly model: BaseChatModel;
  readonly tools: StructuredToolInterface[];
  readonly systemPrompt?: string;
  /** In-memory checkpointer to persist state across turns within a session (FR-3). */
  readonly checkpointer?: BaseCheckpointSaver;
  /** Optional memory store for injecting remembered decisions into the system prompt. */
  readonly memory?: import("../memory.js").MemoryStore;
  /** Getter for the live session id (may change on compact/resume). */
  readonly sessionId?: () => string | undefined;
  /** Optional eviction limits for mid-turn context truncation. */
  readonly eviction?: EvictionLimits;
  /** Optional callback invoked after an eviction pass, with ids of evicted messages. */
  readonly onEvict?: (evictedIds: string[]) => void;
}

/**
 * Build the reason -> act -> observe agent: a LangGraph ReAct loop with the
 * model on one node and the tool registry on the other (FR-1). Provider-agnostic
 * — it depends only on BaseChatModel + the tools (FR-2).
 */
function extractHumanText(m: BaseMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? "");
  }
}

export function buildMemoryPrompt(base: string, memory: import("../memory.js").MemoryStore | undefined, sessionIdGetter: (() => string | undefined) | undefined, state: { messages?: BaseMessage[] }) {
  const messages = state.messages ?? [];
  let effective = base;
  try {
    // find most recent HumanMessage from the end
    const human = [...messages].reverse().find((m) => m._getType && m._getType() === "human");
    if (!human) return [new SystemMessage(base), ...(messages as BaseMessage[])];
    const humanText = extractHumanText(human).slice(0, 200);
    if (!memory) return [new SystemMessage(base), ...(messages as BaseMessage[])];
    const hits = memory.recallByText(humanText, "decision", 3, sessionIdGetter?.());
    if (hits.length > 0) {
      effective += "\n\n## Relevant remembered context\n" + hits.map((h) => `- [memory #${h.id}] ${h.body}`).join("\n");
      // record recall_event and touchUsed only if the very last message is a HumanMessage
      const last = messages.at(-1);
      if (last && last._getType && last._getType() === "human") {
        try {
          memory.recordRecallEvent({ ts: new Date().toISOString(), sessionId: sessionIdGetter?.(), cueKind: "task", cueText: humanText.slice(0, 200), matchedIds: hits.map((h) => h.id), injectedIds: hits.map((h) => h.id) });
        } catch {
          // swallow
        }
        try {
          for (const h of hits) memory.touchUsed(h.id, new Date().toISOString());
        } catch {
          // swallow
        }
      }
    }
  } catch {
    // fallback to base
    return [new SystemMessage(base), ...(messages as BaseMessage[])];
  }
  return [new SystemMessage(effective), ...(messages as BaseMessage[])];
}

export function createAgent(deps: AgentDeps) {
  const promptArg = deps.memory
    ? (state: { messages?: BaseMessage[] }) => buildMemoryPrompt(deps.systemPrompt ?? SYSTEM_PROMPT, deps.memory, deps.sessionId, state)
    : deps.systemPrompt ?? SYSTEM_PROMPT;
  const preModelHook =
    deps.eviction && deps.eviction.evictThresholdTokens > 0
      ? buildEvictionHook(deps.eviction, deps.onEvict)
      : undefined;
  return createReactAgent({
    llm: deps.model,
    tools: deps.tools,
    prompt: promptArg,
    checkpointer: deps.checkpointer,
    ...(preModelHook ? { preModelHook } : {}),
  });
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens reported via usage_metadata.input_token_details.cache_read (AC-62c). */
  cachedInputTokens: number;
  /** Input tokens of the LAST model call in the turn — the current context size (AC-62b). */
  contextTokens: number;
}

export interface StreamOptions {
  /** Optional callback to report token usage at the end of a turn. */
  readonly onUsage?: (usage: UsageTotals) => void;
  /** Checkpointer thread id — turns sharing an id continue one conversation. */
  readonly threadId?: string;
  /** Abort signal to cancel the turn (e.g. on Ctrl-C). */
  readonly signal?: AbortSignal;
  /** Max super-steps per turn; overrides LangGraph's default of 25. */
  readonly recursionLimit?: number;
}

export type Agent = ReturnType<typeof createAgent>;

/**
 * Tag attached to sub-agent runs (FR-59). streamMode "messages" surfaces chat
 * events from ALL descendant runs — including a sub-agent running inside the
 * run_subagent tool — so without filtering, a sub-agent's internal text, tool
 * activity, and token usage all leak into the parent turn's stream: garbled
 * output, clobbered tool-arg correlation, and inflated usage that mis-triggers
 * auto-compaction. Sub-agent runs are invoked with this tag (tags are inherited
 * by descendant runs), and streamAgentEvents drops tagged chunks; sub-agent
 * usage reaches session totals once, via the tool's own onUsage callback.
 */
export const SUBAGENT_TAG = "cody-subagent";

/**
 * Repair a thread whose last message is an AI message with tool calls that
 * never got tool results — what an errored or cancelled turn leaves behind.
 * Providers reject such history on every later turn, so without repair the
 * whole thread is unusable (FR-27). Appends a synthetic "[interrupted]" tool
 * result for each dangling call. Returns true if a repair was made.
 */
export async function repairDanglingToolCalls(agent: Agent, threadId: string): Promise<boolean> {
  const config = { configurable: { thread_id: threadId } };
  const state = await agent.getState(config);
  const messages = (state.values as { messages?: BaseMessage[] }).messages ?? [];
  const last = messages.at(-1);
  if (!last || last._getType() !== "ai") return false;
  const dangling = ((last as AIMessage).tool_calls ?? []).filter((c) => c.id);
  if (dangling.length === 0) return false;
  await agent.updateState(
    config,
    {
      messages: dangling.map(
        (c) =>
          new ToolMessage({
            content: "[interrupted — the turn ended before this tool ran]",
            tool_call_id: c.id as string,
          }),
      ),
    },
    "tools", // write as if the tools node responded, so the graph resumes at the model
  );
  return true;
}

/** Run one turn to completion and return the assistant's final text. */
export async function runAgentOnce(agent: Agent, userText: string): Promise<string> {
  const result = await agent.invoke({ messages: [new HumanMessage(userText)] });
  const last = result.messages.at(-1);
  const content = last?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** Outcome of a tool run, derived from the gate's result markers. */
export type ToolEventStatus = "ok" | "denied" | "blocked" | "error";

export type AgentEvent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      /** Compact JSON of the tool arguments (truncated for display). */
      readonly input: string;
      readonly status: ToolEventStatus;
    };

function compactArgs(args: unknown, max = 80): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : (JSON.stringify(args) ?? "");
  } catch {
    s = "";
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function statusOf(result: unknown): ToolEventStatus {
  if (typeof result !== "string") return "ok";
  if (result.startsWith("[denied")) return "denied";
  if (result.startsWith("[blocked")) return "blocked";
  if (result.startsWith("[error")) return "error";
  return "ok";
}

/**
 * Extract displayable assistant text from a message's content. OpenAI streams
 * text as a plain string; Anthropic streams it as an array of content blocks
 * (e.g. { type: "text", text: "..." }). Without handling the array form, Claude's
 * responses render as empty output.
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (typeof block === "string") out += block;
      else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if ((b.type === "text" || b.type === "text_delta") && typeof b.text === "string") out += b.text;
      }
    }
    return out;
  }
  return "";
}

// Serialize messages one line per message: role plus text content. Tool
// results are truncated to 400 chars. Exported helper used by compactThread and the REPL consolidator.
export function serializeThread(messages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = typeof m._getType === "function" ? m._getType() : "unknown";
    const contentRaw = (m as { content?: unknown }).content;
    let contentStr = "";
    if (typeof contentRaw === "string") contentStr = contentRaw;
    else if (contentRaw !== undefined) {
      try {
        contentStr = JSON.stringify(contentRaw);
      } catch {
        contentStr = String(contentRaw);
      }
    }
    if (role === "tool") {
      if (contentStr.length > 400) contentStr = contentStr.slice(0, 400 - 1) + "…";
    }
    // Collapse newlines to single spaces so each message is one line.
    contentStr = contentStr.replace(/\s+/g, " ").trim();
    lines.push(`${role}: ${contentStr}`);
  }
  return lines.join("\n");
}

/**
 * Stream the turn as typed events (FR-4, FR-25): assistant text as it is
 * produced, plus one "tool" event per completed tool run so the UI can show
 * what the agent is doing between text chunks.
 */
export async function* streamAgentEvents(
  agent: Agent,
  userText: string,
  opts: StreamOptions = {},
): AsyncGenerator<AgentEvent> {
  const stream = await agent.stream(
    { messages: [new HumanMessage(userText)] },
    {
      streamMode: "messages",
      signal: opts.signal,
      ...(opts.recursionLimit ? { recursionLimit: opts.recursionLimit } : {}),
      ...(opts.threadId ? { configurable: { thread_id: opts.threadId } } : {}),
    },
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let contextTokens = 0;
  // Tool arguments arrive on AI chunks (whole, or streamed piecewise); the
  // matching result arrives later as a ToolMessage — correlate by call id.
  const argsByCallId = new Map<string, string>();
  const partialByIndex = new Map<number, { id?: string; args: string }>();

  for await (const chunk of stream) {
    const [msg, meta] = Array.isArray(chunk) ? chunk : [chunk, undefined];
    const tags = (meta as { tags?: string[] } | undefined)?.tags;
    if (tags?.includes(SUBAGENT_TAG)) continue; // sub-agent internals (see SUBAGENT_TAG)
    const type = (msg as { _getType?: () => string })._getType?.();
    const content = (msg as { content?: unknown }).content;
    if (type === "ai") {
      // usage_metadata often rides on chunks with empty text (tool-call and
      // final chunks), so accumulate before the text check.
      const usage = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number } } })
        .usage_metadata;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        // Last call's input_tokens = current context size (AC-62b).
        if (usage.input_tokens) contextTokens = usage.input_tokens;
        // Cache-read tokens (AC-62c). Treat absent as 0.
        if (usage.input_token_details?.cache_read) {
          cachedInputTokens += usage.input_token_details.cache_read;
        }
      }
      const calls = (msg as { tool_calls?: { id?: string; args?: unknown }[] }).tool_calls ?? [];
      for (const call of calls) {
        if (!call.id) continue;
        // Streamed chunks re-parse the args as they accumulate ({} at first),
        // so keep the most complete representation seen for this call id.
        const args = compactArgs(call.args);
        const known = argsByCallId.get(call.id) ?? "";
        if (args.length > known.length) argsByCallId.set(call.id, args);
      }
      const partials =
        (msg as { tool_call_chunks?: { id?: string; args?: string; index?: number }[] })
          .tool_call_chunks ?? [];
      for (const piece of partials) {
        let rec = partialByIndex.get(piece.index ?? 0);
        // A new call id at this index means a new tool call in a later round —
        // start fresh instead of appending to the previous call's args.
        if (!rec || (piece.id && piece.id !== rec.id)) {
          rec = { id: piece.id, args: "" };
          partialByIndex.set(piece.index ?? 0, rec);
        }
        rec.args += piece.args ?? "";
      }
    }
    if (type === "ai") {
      const text = extractText(content);
      if (text.length > 0) yield { kind: "text", text };
    }
    if (type === "tool") {
      const { name, tool_call_id } = msg as { name?: string; tool_call_id?: string };
      let input = (tool_call_id && argsByCallId.get(tool_call_id)) || "";
      if (tool_call_id) {
        const partial = [...partialByIndex.values()].find((r) => r.id === tool_call_id);
        if (partial) {
          const accumulated = compactArgs(partial.args);
          if (accumulated.length > input.length) input = accumulated;
        }
      }
      yield { kind: "tool", name: name ?? "tool", input, status: statusOf(content) };
    }
  }

  if (opts.onUsage) {
    opts.onUsage({ inputTokens, outputTokens, cachedInputTokens, contextTokens });
  }
}

/**
 * Stream only the assistant's text (FR-4) — a thin filter over
 * streamAgentEvents for text-only consumers like headless `cody run`.
 */
export async function* streamAgentText(
  agent: Agent,
  userText: string,
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  for await (const event of streamAgentEvents(agent, userText, opts)) {
    if (event.kind === "text") yield event.text;
  }
}

/**
 * Compact a thread into a new thread by summarizing its messages using the
 * provided summarizer. Returns the number of messages compacted and the
 * produced summary.
 */
export async function compactThread(
  agent: Agent,
  summarizer: BaseChatModel,
  fromThreadId: string,
  toThreadId: string,
  onUsage?: (u: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) => void,
): Promise<{ messageCount: number; summary: string }> {
  const config = { configurable: { thread_id: fromThreadId } };
  const state = await agent.getState(config);
  const messages = (state.values as { messages?: BaseMessage[] }).messages ?? [];

  const serialized = serializeThread(messages);
  const prompt =
    "Summarize this coding-assistant conversation faithfully so work can continue seamlessly in a fresh thread. Preserve: key facts and decisions, file paths and code identifiers, what has been done, current state, and open tasks. Be concise but lose nothing load-bearing.\n\n" +
    serialized;

  // Invoke the summarizer with a single HumanMessage. Call invoke as a
  // method on the summarizer (do not detach).
  const res = await summarizer.invoke([new HumanMessage(prompt)]);
  if (onUsage) {
    const meta = (res as { usage_metadata?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number } } }).usage_metadata;
    if (meta) {
      onUsage({
        inputTokens: meta.input_tokens ?? 0,
        outputTokens: meta.output_tokens ?? 0,
        cachedInputTokens: meta.input_token_details?.cache_read ?? 0,
      });
    }
  }
  const summary = extractText((res as { content?: unknown }).content);
  if (!summary) throw new Error("summarizer returned empty content");

  // Seed the new thread with the summary as a HumanMessage.
  await agent.updateState({ configurable: { thread_id: toThreadId } }, { messages: [new HumanMessage("[Summary of the previous conversation]\n" + summary)] });

  return { messageCount: messages.length, summary };
}
