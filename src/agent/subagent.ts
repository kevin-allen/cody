import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import type { ToolContext } from "../tools/index.js";
import { createTools, gate } from "../tools/index.js";
import { createAgent, extractText, SUBAGENT_TAG } from "./graph.js";
import type { UsageTotals } from "./graph.js";

/** Read-only tool names the subagent is allowed to use. Exported for tests. */
export const READ_ONLY_TOOL_NAMES = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "load_skill",
  "read_skill_file",
]);

/** System prompt for the subagent — read-only exploration, distinct from the parent. */
export const SUBAGENT_SYSTEM_PROMPT =
  "You are a read-only exploration sub-agent. Investigate thoroughly with the " +
  "read_file, list_dir, glob, grep, load_skill, and read_skill_file tools. " +
  "Your final message must be a self-contained report of findings: paths, " +
  "identifiers, key facts, and relevant context. You cannot edit files, run " +
  "shell commands, or delegate to another sub-agent.";

export interface SubagentDeps {
  /** Model for the subagent. */
  readonly model: BaseChatModel;
  /** Parent ToolContext — subagent tools share workdir/config/confirm/memory/sessionId. */
  readonly ctx: ToolContext;
  readonly recursionLimit?: number;
  /** Called with the subagent's summed token usage after each run. */
  readonly onUsage?: (usage: UsageTotals) => void;
}

const MAX_RESULT_CHARS = 8000;
const TRUNCATION_MARKER = "\n[subagent report truncated]";

function sumUsage(messages: BaseMessage[]): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let contextTokens = 0;
  for (const m of messages) {
    if (m._getType() !== "ai") continue;
    const usage = (m as AIMessage).usage_metadata as
      | { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number } }
      | undefined;
    if (usage) {
      inputTokens += usage.input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      if (usage.input_tokens) contextTokens = usage.input_tokens;
      if (usage.input_token_details?.cache_read) {
        cachedInputTokens += usage.input_token_details.cache_read;
      }
    }
  }
  return { inputTokens, outputTokens, cachedInputTokens, contextTokens };
}

export function createSubagentTool(deps: SubagentDeps): StructuredToolInterface {
  return tool(
    async ({ task }, config) => {
      const preview = task.length > 200 ? task.slice(0, 197) + "..." : task;
      return gate(
        deps.ctx,
        { action: "agent", title: "Run subagent", preview },
        async () => {
          // Build the full toolset then keep only read-only tools.
          const allTools = createTools(deps.ctx);
          const readOnlyTools = allTools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));

          const checkpointer = new MemorySaver();
          const subagent = createAgent({
            model: deps.model,
            tools: readOnlyTools,
            checkpointer,
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
          });

          try {
            const result = await subagent.invoke(
              { messages: [new HumanMessage(task)] },
              {
                configurable: { thread_id: "subagent" },
                recursionLimit: deps.recursionLimit,
                signal: (config as { signal?: AbortSignal } | undefined)?.signal,
                // Inherited by every descendant run; keeps sub-agent chunks out
                // of the parent's stream (see SUBAGENT_TAG in graph.ts).
                tags: [SUBAGENT_TAG],
              },
            );

            const messages: BaseMessage[] = (result.messages ?? []) as BaseMessage[];
            const last = messages.at(-1);
            const text = extractText(last?.content);

            // Report usage.
            if (deps.onUsage) {
              deps.onUsage(sumUsage(messages));
            }

            // Truncate if needed.
            if (text.length > MAX_RESULT_CHARS) {
              return text.slice(0, MAX_RESULT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
            }
            return text;
          } catch (err) {
            return `[error] subagent failed: ${(err as Error).message}`;
          }
        },
      );
    },
    {
      name: "run_subagent",
      description:
        "Delegate a read-only exploration task to a sub-agent with fresh context.",
      schema: z.object({
        task: z.string().describe("The exploration task for the sub-agent."),
      }),
    },
  );
}
