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
    // Newest 2 always protected regardless of keepRecentToolResults;
    // keepRecentToolResults=1: only newest 1 conditionally protected (pos 3..1).
    // t2,t3 are newest 2 → always protected; t1 is evictable.
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

    // t1 should be truncated (oldest, beyond both newest-2 and keepRecent=1);
    // t2 and t3 are newest 2 → protected
    expect(messages.length).toBe(1);
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).toContain("t1");
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

    // t4,t5 always protected (newest 2); t3 protected (≤ 20000 chars, in 3..3);
    // t1, t2 evicted
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

    // t1 is short, t2 is in newest 2 → both protected, no evictions
    expect(result).toEqual({});
  });

  it("when evictable, replacements preserve id and tool_call_id", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    // 3 tool messages so the first is beyond newest-2 and evictable
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      new ToolMessage({ content: "A".repeat(700), tool_call_id: "call-abc", id: "msg-xyz" }),
      ai(200),
      longTool("t2", "c2"),
      ai(180),
      longTool("t3", "c3"),
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
    // First wave: t1,t2 are only 2 tool msgs → both in newest 2 → no evictions
    let msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      longTool("t2", "c2"),
    ];
    const first = hook({ messages: msgs });
    expect(first).toEqual({});

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
    // t3,t4 are newest 2 → protected
    // t1,t2 are beyond newest 2 and beyond keepRecentToolResults=1 → evictable
    const ids = secondMsgs.map((m) => (m as ToolMessage).id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t3"); // newest 2, protected
  });

  it("keepRecentToolResults=0 leaves newest 2 protected but evicts earlier long messages", () => {
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
    // newest 2 (t2,t3) always protected; t1 evicted
    expect(ids).toEqual(["t1"]);
  });

  it("skips tool messages that already contain EVICTION_MARKER", () => {
    // 4 tool msgs so we test: t1 already evicted (skipped), t2 (pos 4) evicted,
    // t3,t4 newest 2 → protected
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
      ai(180),
      longTool("t3", "c3"),
      ai(180),
      longTool("t4", "c4"),
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;
    const ids = messages.map((m) => (m as ToolMessage).id);
    // t1 already has EVICTION_MARKER, should be skipped; t2 evicted; t3,t4 newest 2 → protected
    expect(ids).not.toContain("t1"); // already evicted, skipped
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t3");
    expect(ids).not.toContain("t4");
  });

  it("always protects the newest 2 tool results regardless of size", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 0 });
    const huge = new ToolMessage({ content: "B".repeat(50_000), tool_call_id: "h1", id: "huge1" });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      huge,
      ai(180),
      longTool("t3", "c3"),
    ];
    const result = hook({ messages: msgs });
    // t1 (pos 3) is evictable; huge (pos 2) and t3 (pos 1) are newest 2 → protected
    const messages = (result as { messages: BaseMessage[] }).messages;
    const ids = messages.map((m) => (m as ToolMessage).id);
    expect(ids).toEqual(["t1"]);
    expect(ids).not.toContain("huge1");
    expect(ids).not.toContain("t3");
  });

  it("evicts oversized tool results in the 3..keepRecentToolResults range", () => {
    const hook = buildEvictionHook({ evictThresholdTokens: 100, keepRecentToolResults: 4 });
    const huge = new ToolMessage({ content: "B".repeat(30_000), tool_call_id: "h1", id: "huge1" });
    const msgs: BaseMessage[] = [
      new HumanMessage("task"),
      ai(150),
      longTool("t1", "c1"),
      ai(200),
      huge, // pos 4 from end, in 3..4 range, but 30000 > 20000 → evictable
      ai(180),
      longTool("t3", "c3"), // pos 3, in 3..4 range, 700 ≤ 20000 → protected
      ai(180),
      longTool("t4", "c4"), // pos 2 → always protected
      ai(180),
      longTool("t5", "c5"), // pos 1 → always protected
    ];
    const result = hook({ messages: msgs });
    const messages = (result as { messages: BaseMessage[] }).messages;
    const ids = messages.map((m) => (m as ToolMessage).id);
    // t1 evicted (pos 5, beyond keepRecent); huge1 evicted (oversized in 3..4 range);
    // t3,t4,t5 protected
    expect(ids).toContain("t1");
    expect(ids).toContain("huge1");
    expect(ids).not.toContain("t3");
    expect(ids).not.toContain("t4");
    expect(ids).not.toContain("t5");
  });
});
