import { describe, it, expect } from "vitest";
import { AIMessage, ToolMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { buildEvictionHook, EVICTION_MARKER } from "./context.js";
import type { EvictionLimits } from "./context.js";

function ai(inputTokens: number): AIMessage {
  return new AIMessage({
    content: "thinking...",
    usage_metadata: { input_tokens: inputTokens, output_tokens: 50, total_tokens: inputTokens + 50 },
  });
}

function aiNoUsage(): AIMessage {
  return new AIMessage({ content: "thinking..." });
}

function toolMsg(id: string, callId: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: callId, id });
}

function longTool(id: string, callId: string): ToolMessage {
  return toolMsg(id, callId, "A".repeat(700));
}

function shortTool(id: string, callId: string): ToolMessage {
  return toolMsg(id, callId, "short");
}

const defaults: EvictionLimits = {
  evictThresholdTokens: 32768,
  keepRecentToolResults: 5,
};

describe("buildEvictionHook", () => {
  it("returns {} when evictThresholdTokens is 0 (disabled)", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 0, keepRecentToolResults: 5 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(100000),
      longTool("t1", "c1"),
    ];
    expect(hook({ messages: msgs })).toEqual({});
  });

  it("returns {} when no AI message has usage_metadata.input_tokens", () => {
    const hook = buildEvictionHook(defaults);
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      aiNoUsage(),
      longTool("t1", "c1"),
    ];
    expect(hook({ messages: msgs })).toEqual({});
  });

  it("returns {} when input_tokens is below the threshold", () => {
    const hook = buildEvictionHook(defaults);
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(30000), // < 32768
      longTool("t1", "c1"),
    ];
    expect(hook({ messages: msgs })).toEqual({});
  });

  it("returns {} when input_tokens equals the threshold", () => {
    const hook = buildEvictionHook(defaults);
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(32768),
      longTool("t1", "c1"),
    ];
    expect(hook({ messages: msgs })).toEqual({});
  });

  it("truncates old-enough, long-enough tool messages when above threshold", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 1 });
    // keepRecentToolResults=1: the most recent tool result is kept untouched
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150), // above 100
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
      ai(180),
      longTool("t3", "c3"), // most recent, should be kept
    ];
    const result = hook({ messages: msgs });
    expect(result).toHaveProperty("messages");
    const messages = (result as { messages: BaseMessage[] }).messages;

    // t1 and t2 should be truncated (old), t3 kept (most recent 1)
    expect(messages.length).toBe(2);
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    for (const m of messages) {
      const content = typeof m.content === "string" ? m.content : "";
      expect(content).toContain(EVICTION_MARKER);
    }
  });

  it("keeps the most recent K tool results untouched", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 3 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
      ai(180),
      longTool("t3", "c3"),
      ai(180),
      longTool("t4", "c4"),
      ai(180),
      longTool("t5", "c5"),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;

    // t1, t2 should be truncated; t3, t4, t5 kept (most recent 3)
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).toEqual(["t1", "t2"]);
  });

  it("never truncates tool messages with short content (<= 600 chars)", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      shortTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;

    // t1 is short (< 600), should NOT be in replacements; t2 is long, should be
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).not.toContain("t1");
    expect(ids).toContain("t2");
  });

  it("replacements preserve id and tool_call_id", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      new ToolMessage({ content: "A".repeat(700), tool_call_id: "call-abc", id: "msg-xyz" }),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;
    expect(messages.length).toBe(1);
    const tm = messages[0] as ToolMessage;
    expect(tm.id).toBe("msg-xyz");
    expect(tm.tool_call_id).toBe("call-abc");
  });

  it("is IDEMPOTENT: feeding the hook its own output state returns {}", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 1 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
      ai(180),
      longTool("t3", "c3"),
    ];
    const first = hook({ messages: msgs });
    expect(first).toHaveProperty("messages");
    expect((first as { messages: BaseMessage[] }).messages.length).toBeGreaterThan(0);

    // Simulate what add_messages does: upsert the replacements into the state.
    const firstReplacements = (first as { messages: BaseMessage[] }).messages;
    const merged = [...msgs];
    for (const r of firstReplacements) {
      const idx = merged.findIndex((m) => m.id === r.id);
      if (idx >= 0) merged[idx] = r;
    }
    // Inject a fresh AI message with high usage so the threshold is still crossed.
    merged.push(ai(99999));

    const second = hook({ messages: merged });
    // Already-evicted messages contain EVICTION_MARKER and must be skipped.
    // The only new tool message added after the first eviction is... none in this test.
    // So the second call should return {}.
    expect(second).toEqual({});
  });

  it("second eviction wave can catch new tool results added after the first wave", () => {
    // After the first eviction wave, new tool results may be added. A second
    // wave should evict those new results (not the already-evicted ones).
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 1 });
    // First wave: evicts t1
    let msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"), // kept (most recent 1)
    ];
    const first = hook({ messages: msgs });
    const firstReplacements = (first as { messages: BaseMessage[] }).messages;
    for (const r of firstReplacements) {
      const idx = msgs.findIndex((m) => m.id === r.id);
      if (idx >= 0) msgs[idx] = r;
    }

    // Add new tool results after the first wave
    msgs = [
      ...msgs,
      ai(99999),
      longTool("t3", "c3"),
      ai(99999),
      longTool("t4", "c4"), // most recent, should be kept
    ];

    const second = hook({ messages: msgs });
    const secondMsgs = (second as { messages: BaseMessage[] }).messages;
    // t1 already has EVICTION_MARKER, should NOT be re-evicted
    // t2 was kept before, now with keepRecentToolResults=1 and t4 after it, t2 and t3 are both evictable
    const ids = secondMsgs.map((m) => (m as ToolMessage).id);
    expect(ids).not.toContain("t1"); // already evicted, skipped
    expect(ids).toContain("t2"); // old result, now evictable
    expect(ids).toContain("t3"); // new long result, should be evicted
  });

  it("keepRecentToolResults=0 evicts all long tool messages", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
      ai(180),
      longTool("t3", "c3"),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("skips tool messages that already contain EVICTION_MARKER", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    const alreadyEvicted = new ToolMessage({
      content: "A".repeat(500) + "\n" + EVICTION_MARKER,
      tool_call_id: "c1",
      id: "t1",
    });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      alreadyEvicted,
      ai(200),
      longTool("t2", "c2"),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;
    const ids = messages.map((m) => (m as ToolMessage).id);
    // t1 already has EVICTION_MARKER, should be skipped; t2 is fresh
    expect(ids).not.toContain("t1");
    expect(ids).toContain("t2");
  });
});
