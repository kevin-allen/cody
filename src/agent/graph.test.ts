import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { resolveConfig } from "../config.js";
import { createTools } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { createAgent, runAgentOnce, streamAgentEvents, repairDanglingToolCalls, extractText, SUBAGENT_TAG } from "./graph.js";
import type { AgentEvent } from "./graph.js";
import { EVICTION_MARKER } from "./context.js";

/**
 * A minimal chat model that returns a scripted sequence of AI messages,
 * so the ReAct loop can be exercised offline (no API key, deterministic).
 */
class ScriptedToolModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly responses: AIMessage[]) {
    super({} as BaseChatModelParams);
  }
  _llmType(): string {
    return "scripted-tool";
  }
  override bindTools(_tools: unknown[]): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.responses[Math.min(this.index, this.responses.length - 1)]!;
    this.index += 1;
    const text = typeof message.content === "string" ? message.content : "";
    return { generations: [{ message, text }] };
  }
}

let wd: string;
beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), "cody-agent-"));
});
afterEach(() => rmSync(wd, { recursive: true, force: true }));

function ctx(mode: "auto" | "readonly"): ToolContext {
  return {
    workdir: wd,
    config: resolveConfig({ env: { CODY_MODE: mode } }),
    confirm: () => Promise.resolve({ approved: true as const }),
  };
}

describe("extractText", () => {
  it("renders plain strings and Anthropic-style content-block arrays, ignoring non-text blocks", () => {
    // (a) plain string returns itself
    expect(extractText("Hello world")).toBe("Hello world");

    // (b) Anthropic-style array of text blocks joins into one string
    expect(
      extractText([
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ]),
    ).toBe("Hello world");

    // (c) non-text blocks (e.g. tool_use) contribute no text
    expect(
      extractText([
        { type: "tool_use", name: "x" },
        { type: "text", text: "Hi" },
      ]),
    ).toBe("Hi");

    // (d) non-string, non-array content returns ""
    expect(extractText(undefined)).toBe("");
  });
});

describe("agent ReAct loop", () => {
  it("executes a tool the model requests, then returns the final answer (auto mode)", async () => {
    const model = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "out.txt", content: "hello" } }],
      }),
      new AIMessage({ content: "Done." }),
    ]);
    const agent = createAgent({ model, tools: createTools(ctx("auto")) });

    const result = await runAgentOnce(agent, "create out.txt");

    expect(existsSync(join(wd, "out.txt"))).toBe(true);
    expect(readFileSync(join(wd, "out.txt"), "utf8")).toBe("hello");
    expect(result).toContain("Done");
  });

  it("the permission gate blocks a tool inside the loop (readonly mode)", async () => {
    const model = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "out.txt", content: "hello" } }],
      }),
      new AIMessage({ content: "I could not write the file." }),
    ]);
    const agent = createAgent({ model, tools: createTools(ctx("readonly")) });

    const result = await runAgentOnce(agent, "create out.txt");

    expect(existsSync(join(wd, "out.txt"))).toBe(false); // gate denied the write
    expect(result).toContain("could not");
  });
});

describe("streamAgentEvents", () => {
  async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  it("emits a tool event (name, args, ok) for an executed tool, then the text", async () => {
    const model = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "out.txt", content: "hi" } }],
      }),
      new AIMessage({ content: "Done." }),
    ]);
    const agent = createAgent({ model, tools: createTools(ctx("auto")) });

    const events = await collect(streamAgentEvents(agent, "create out.txt"));

    const tool = events.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "write_file", status: "ok" });
    expect(tool?.kind === "tool" && tool.input).toContain("out.txt");
    const text = events.filter((e) => e.kind === "text");
    expect(text.map((e) => (e.kind === "text" ? e.text : "")).join("")).toContain("Done");
  });

  it("marks a gate-denied tool run with status denied", async () => {
    const model = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "write_file", args: { path: "out.txt", content: "hi" } }],
      }),
      new AIMessage({ content: "Could not write." }),
    ]);
    const agent = createAgent({ model, tools: createTools(ctx("readonly")) });

    const events = await collect(streamAgentEvents(agent, "create out.txt"));

    const tool = events.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "write_file", status: "denied" });
  });
});

describe("repairDanglingToolCalls", () => {
  it("repairs a thread poisoned by a turn that died mid tool-call, so the next turn works", async () => {
    const model = new ScriptedToolModel([
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "list_dir", args: { path: "." } }],
      }),
      new AIMessage({ content: "Done." }),
    ]);
    const agent = createAgent({
      model,
      tools: createTools(ctx("auto")),
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "t1" } };

    // Recursion limit 1 kills the turn right after the model emits tool_calls,
    // leaving them dangling in the checkpoint — the poisoned-thread scenario.
    await expect(
      agent.invoke({ messages: [new HumanMessage("go")] }, { ...config, recursionLimit: 1 }),
    ).rejects.toThrow(/[Rr]ecursion limit/);

    expect(await repairDanglingToolCalls(agent, "t1")).toBe(true);

    // The synthetic tool result is in the thread and the next turn completes.
    const state = await agent.getState(config);
    const messages = (state.values as { messages: BaseMessage[] }).messages;
    expect(messages.at(-1)?._getType()).toBe("tool");
    expect(messages.at(-1)?.content).toContain("[interrupted");

    const result = await agent.invoke({ messages: [new HumanMessage("continue")] }, config);
    const final = result.messages.at(-1);
    expect(final?.content).toContain("Done");
  });

  it("is a no-op on a healthy thread", async () => {
    const model = new ScriptedToolModel([new AIMessage({ content: "Hi." })]);
    const agent = createAgent({
      model,
      tools: createTools(ctx("auto")),
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "t2" } };
    await agent.invoke({ messages: [new HumanMessage("hello")] }, config);

    expect(await repairDanglingToolCalls(agent, "t2")).toBe(false);
  });
});

describe("streamAgentEvents sub-agent filtering (SUBAGENT_TAG)", () => {
  it("drops tagged sub-agent chunks from events and usage totals", async () => {
    // streamMode "messages" surfaces descendant-run chunks; sub-agent runs are
    // tagged and must not contribute text, tool events, or usage to the parent.
    const tuples: [unknown, unknown][] = [
      [
        new AIMessageChunk({
          content: "parent text",
          usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        } as never),
        { tags: ["seq:step:1"] },
      ],
      [
        new AIMessageChunk({
          content: "child text",
          usage_metadata: { input_tokens: 5000, output_tokens: 900, total_tokens: 5900 },
        } as never),
        { tags: [SUBAGENT_TAG, "other"] },
      ],
      [new ToolMessage({ content: "child read result", tool_call_id: "child-1", name: "read_file" }), { tags: [SUBAGENT_TAG] }],
      [new ToolMessage({ content: "parent tool ok [exit 0]", tool_call_id: "parent-1", name: "run_shell" }), { tags: [] }],
    ];
    const fakeAgent = {
      stream: async () =>
        (async function* () {
          for (const t of tuples) yield t;
        })(),
    } as unknown as ReturnType<typeof createAgent>;

    const events: AgentEvent[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const e of streamAgentEvents(fakeAgent, "task", { onUsage: (u) => (usage = u) })) {
      events.push(e);
    }

    const texts = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["parent text"]);
    const toolNames = events.filter((e) => e.kind === "tool").map((e) => (e as { name: string }).name);
    expect(toolNames).toEqual(["run_shell"]);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, contextTokens: 10 });
  });
});

describe("streamAgentEvents cache-aware usage (AC-62c)", () => {
  it("accumulates cache_read across chunks and sets contextTokens to last call's input", async () => {
    // Simulate a turn with two model calls: first with cache hits, second without.
    // Each call's final chunk carries the call's full usage_metadata.
    const tuples: [unknown, unknown][] = [
      [
        new AIMessageChunk({
          content: "first response",
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_token_details: { cache_read: 80 },
          },
        } as never),
        { tags: ["seq:step:1"] },
      ],
      [
        new AIMessageChunk({
          content: "second response",
          usage_metadata: {
            input_tokens: 200,
            output_tokens: 30,
            total_tokens: 230,
            input_token_details: { cache_read: 150 },
          },
        } as never),
        { tags: ["seq:step:3"] },
      ],
    ];
    const fakeAgent = {
      stream: async () =>
        (async function* () {
          for (const t of tuples) yield t;
        })(),
    } as unknown as ReturnType<typeof createAgent>;

    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; contextTokens: number } | undefined;
    for await (const _e of streamAgentEvents(fakeAgent, "task", {
      onUsage: (u) => (usage = u),
    })) {
      // drain
    }

    expect(usage).toBeDefined();
    // inputTokens = sum across both calls
    expect(usage!.inputTokens).toBe(300);
    expect(usage!.outputTokens).toBe(80);
    // cachedInputTokens = sum of cache_read across both calls
    expect(usage!.cachedInputTokens).toBe(230);
    // contextTokens = LAST call's input_tokens (not the sum)
    expect(usage!.contextTokens).toBe(200);
  });

  it("sets cachedInputTokens to 0 when input_token_details is absent (no NaN)", async () => {
    const tuples: [unknown, unknown][] = [
      [
        new AIMessageChunk({
          content: "response",
          usage_metadata: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        } as never),
        { tags: ["seq:step:1"] },
      ],
    ];
    const fakeAgent = {
      stream: async () =>
        (async function* () {
          for (const t of tuples) yield t;
        })(),
    } as unknown as ReturnType<typeof createAgent>;

    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; contextTokens: number } | undefined;
    for await (const _e of streamAgentEvents(fakeAgent, "task", {
      onUsage: (u) => (usage = u),
    })) {
      // drain
    }

    expect(usage!.cachedInputTokens).toBe(0);
    expect(usage!.contextTokens).toBe(50);
  });
});

describe("streamAgentEvents contextTokens (AC-62b / FR-47)", () => {
  it("contextTokens is last call's input, NOT the cumulative sum", async () => {
    // Three model calls: first 5000 input, second 3000 input, third 140000 input.
    // The cumulative sum = 148000, but contextTokens should = 140000 (last call).
    // Auto-compaction should trigger on 140000, not 148000 (both > threshold in
    // most configs, but the metric is what matters: context size, not re-send volume).
    const tuples: [unknown, unknown][] = [
      [
        new AIMessageChunk({
          content: "",
          usage_metadata: { input_tokens: 5000, output_tokens: 100 },
        } as never),
        { tags: ["seq:step:1"] },
      ],
      [
        new AIMessageChunk({
          content: "",
          usage_metadata: { input_tokens: 3000, output_tokens: 80 },
        } as never),
        { tags: ["seq:step:3"] },
      ],
      [
        new AIMessageChunk({
          content: "final response",
          usage_metadata: { input_tokens: 140000, output_tokens: 200 },
        } as never),
        { tags: ["seq:step:5"] },
      ],
    ];
    const fakeAgent = {
      stream: async () =>
        (async function* () {
          for (const t of tuples) yield t;
        })(),
    } as unknown as ReturnType<typeof createAgent>;

    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; contextTokens: number } | undefined;
    for await (const _e of streamAgentEvents(fakeAgent, "task", {
      onUsage: (u) => (usage = u),
    })) {
      // drain
    }

    expect(usage!.inputTokens).toBe(148000); // cumulative sum
    expect(usage!.contextTokens).toBe(140000); // last call only — the context size
  });

  it("contextTokens is 0 when no AI chunk carries usage_metadata", async () => {
    const tuples: [unknown, unknown][] = [
      [new AIMessageChunk({ content: "bare chunk without usage" } as never), { tags: [] }],
    ];
    const fakeAgent = {
      stream: async () =>
        (async function* () {
          for (const t of tuples) yield t;
        })(),
    } as unknown as ReturnType<typeof createAgent>;

    let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; contextTokens: number } | undefined;
    for await (const _e of streamAgentEvents(fakeAgent, "task", {
      onUsage: (u) => (usage = u),
    })) {
      // drain
    }

    expect(usage!.contextTokens).toBe(0);
    expect(usage!.inputTokens).toBe(0);
  });
});

describe("mid-turn eviction integration (FR-62)", () => {
  it("evicts early tool results so the final state contains EVICTION_MARKER but last K stay intact", async () => {
    // Create a file with long content so read_file results exceed 600 chars.
    writeFileSync(join(wd, "long.txt"), "A".repeat(1000), "utf8");

    // 8 tool calls to read_file "long.txt", each with usage_metadata above threshold.
    // keepRecentToolResults = 2 → the last 2 tool results survive untouched.
    const KEEP = 2;
    const TOTAL_TOOLS = 8;
    const responses: AIMessage[] = [];
    for (let i = 0; i < TOTAL_TOOLS; i++) {
      responses.push(
        new AIMessage({
          content: "",
          tool_calls: [{ id: `c${i}`, name: "read_file", args: { path: "long.txt" } }],
          usage_metadata: { input_tokens: 50000, output_tokens: 100, total_tokens: 50100 },
        }),
      );
    }
    responses.push(new AIMessage({ content: "All done." }));

    const model = new ScriptedToolModel(responses);
    const toolCtx = ctx("auto");
    const checkpointer = new MemorySaver();

    const agent = createAgent({
      model,
      tools: createTools(toolCtx),
      checkpointer,
      eviction: { evictThresholdTokens: 1000, keepRecentToolResults: KEEP },
    });

    const config = { configurable: { thread_id: "eviction-test" }, recursionLimit: 100 };
    await agent.invoke(
      { messages: [new HumanMessage("list dir repeatedly")] },
      config,
    );

    // Read the final state from the checkpointer.
    const state = await agent.getState(config);
    const messages = (state.values as { messages: BaseMessage[] }).messages;

    // Filter to ToolMessages.
    const toolMessages = messages.filter((m) => m._getType() === "tool") as ToolMessage[];
    expect(toolMessages.length).toBe(TOTAL_TOOLS);

    // Early tool results (the first TOTAL_TOOLS - KEEP) should have EVICTION_MARKER.
    const evicted = toolMessages.slice(0, TOTAL_TOOLS - KEEP);
    for (const tm of evicted) {
      const content = typeof tm.content === "string" ? tm.content : "";
      expect(content).toContain(EVICTION_MARKER);
    }

    // The last KEEP results should NOT have EVICTION_MARKER.
    const kept = toolMessages.slice(-KEEP);
    for (const tm of kept) {
      const content = typeof tm.content === "string" ? tm.content : "";
      expect(content).not.toContain(EVICTION_MARKER);
    }
  });

  it("calls onEvict callback with ids when eviction happens", async () => {
    const KEEP = 1;
    const TOTAL_TOOLS = 5;
    // Results must exceed the hook's 600-char floor or nothing is evictable.
    writeFileSync(join(wd, "long.txt"), "x".repeat(2000));
    const responses: AIMessage[] = [];
    for (let i = 0; i < TOTAL_TOOLS; i++) {
      responses.push(
        new AIMessage({
          content: "",
          tool_calls: [{ id: `c${i}`, name: "read_file", args: { path: "long.txt" } }],
          usage_metadata: { input_tokens: 50000, output_tokens: 100, total_tokens: 50100 },
        }),
      );
    }
    responses.push(new AIMessage({ content: "All done." }));

    const model = new ScriptedToolModel(responses);
    const toolCtx = ctx("auto");
    const checkpointer = new MemorySaver();
    const evictedCalls: string[][] = [];

    const agent = createAgent({
      model,
      tools: createTools(toolCtx),
      checkpointer,
      eviction: { evictThresholdTokens: 1000, keepRecentToolResults: KEEP },
      onEvict: (ids) => { evictedCalls.push(ids); },
    });

    const config = { configurable: { thread_id: "onEvict-test" }, recursionLimit: 100 };
    await agent.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    );

    // onEvict should have been called at least once since eviction happened
    expect(evictedCalls.length).toBeGreaterThanOrEqual(1);
    // All callbacks should contain at least one id
    for (const ids of evictedCalls) {
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});
