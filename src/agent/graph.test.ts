import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { resolveConfig } from "../config.js";
import { createTools } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { createAgent, runAgentOnce, streamAgentEvents, repairDanglingToolCalls } from "./graph.js";
import type { AgentEvent } from "./graph.js";

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
