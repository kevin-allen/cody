import { ToolMessage } from "@langchain/core/messages";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

export interface EvictionLimits {
  /** Trigger when the previous call's input tokens exceed this. 0 disables. */
  readonly evictThresholdTokens: number;   // config default 32768
  /** Most recent tool results kept untouched. */
  readonly keepRecentToolResults: number;  // config default 5
}

export const EVICTION_MARKER = "[evicted: output truncated after later rounds — re-run the tool if needed]";

/**
 * Build a preModelHook that permanently truncates stale ToolMessage
 * results when the context exceeds a threshold. The hook is IDEMPOTENT:
 * after the first eviction event, already-evicted messages are skipped
 * and the returned state is empty, so the prefix stays cache-stable.
 */
export function buildEvictionHook(
  limits: EvictionLimits,
): (state: { messages: BaseMessage[] }) => { messages: BaseMessage[] } | Record<string, never> {
  return (state: { messages: BaseMessage[] }): { messages: BaseMessage[] } | Record<string, never> => {
    // 1. Disabled.
    if (limits.evictThresholdTokens <= 0) return {};

    // 2. Find the last AI message carrying usage_metadata.input_tokens.
    const messages = state.messages;
    let lastInputTokens: number | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?._getType() === "ai") {
        const usage = (m as AIMessage).usage_metadata as
          | { input_tokens?: number }
          | undefined;
        if (usage?.input_tokens !== undefined) {
          lastInputTokens = usage.input_tokens;
          break;
        }
      }
    }
    if (lastInputTokens === undefined || lastInputTokens <= limits.evictThresholdTokens) {
      return {};
    }

    // 3. Candidates: ToolMessages EXCEPT the most recent keepRecentToolResults,
    //    whose text content is longer than 600 chars and does NOT already
    //    contain EVICTION_MARKER (idempotence).
    const toolMessages: { index: number; msg: ToolMessage }[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m?._getType() === "tool") {
        toolMessages.push({ index: i, msg: m as ToolMessage });
      }
    }

    const keep = Math.max(0, limits.keepRecentToolResults);
    const older = keep > 0 ? toolMessages.slice(0, -keep) : toolMessages;

    const replacements: ToolMessage[] = [];
    for (const { msg } of older) {
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (content.length <= 600) continue;
      if (content.includes(EVICTION_MARKER)) continue; // already evicted — idempotent
      const truncated = content.slice(0, 500) + "\n" + EVICTION_MARKER;
      replacements.push(
        new ToolMessage({
          content: truncated,
          tool_call_id: msg.tool_call_id,
          id: msg.id,
        }),
      );
    }

    if (replacements.length === 0) return {};
    return { messages: replacements };
  };
}
