import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface AgentDeps {
  readonly model: BaseChatModel;
  readonly tools: StructuredToolInterface[];
  readonly systemPrompt?: string;
  /** In-memory checkpointer to persist state across turns within a session (FR-3). */
  readonly checkpointer?: BaseCheckpointSaver;
}

/**
 * Build the reason -> act -> observe agent: a LangGraph ReAct loop with the
 * model on one node and the tool registry on the other (FR-1). Provider-agnostic
 * — it depends only on BaseChatModel + the tools (FR-2).
 */
export function createAgent(deps: AgentDeps) {
  return createReactAgent({
    llm: deps.model,
    tools: deps.tools,
    prompt: deps.systemPrompt ?? SYSTEM_PROMPT,
    checkpointer: deps.checkpointer,
  });
}

export interface StreamOptions {
  /** Checkpointer thread id — turns sharing an id continue one conversation. */
  readonly threadId?: string;
  /** Abort signal to cancel the turn (e.g. on Ctrl-C). */
  readonly signal?: AbortSignal;
}

export type Agent = ReturnType<typeof createAgent>;

/** Run one turn to completion and return the assistant's final text. */
export async function runAgentOnce(agent: Agent, userText: string): Promise<string> {
  const result = await agent.invoke({ messages: [new HumanMessage(userText)] });
  const last = result.messages.at(-1);
  const content = last?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Stream the assistant's text as it is produced (FR-4). Yields only AI text
 * chunks — tool calls and tool results are not surfaced here.
 */
export async function* streamAgentText(
  agent: Agent,
  userText: string,
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  const stream = await agent.stream(
    { messages: [new HumanMessage(userText)] },
    {
      streamMode: "messages",
      signal: opts.signal,
      ...(opts.threadId ? { configurable: { thread_id: opts.threadId } } : {}),
    },
  );
  for await (const chunk of stream) {
    const msg = Array.isArray(chunk) ? chunk[0] : chunk;
    const type = (msg as { _getType?: () => string })._getType?.();
    const content = (msg as { content?: unknown }).content;
    if (type === "ai" && typeof content === "string" && content.length > 0) {
      yield content;
    }
  }
}
