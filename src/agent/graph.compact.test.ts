import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "./graph.js";
import { compactThread } from "./graph.js";

// Scripted model that returns a single AIMessage with the desired summary
class ScriptedSummarizer extends BaseChatModel {
  constructor(private readonly summary: string) {
    super({} as BaseChatModelParams);
  }
  _llmType(): string {
    return "scripted-summary";
  }
  override bindTools(_tools: unknown[]): this {
    return this;
  }
  async _generate(_messages: unknown[]): Promise<ChatResult> {
    const msg = new AIMessage({ content: this.summary });
    return { generations: [{ message: msg, text: this.summary }] };
  }
}

// Use existing ScriptedToolModel from graph.test? To avoid circular imports, we'll
// create a minimal scripted agent model that emits one AI message in response
// to the user's first input so we can seed a thread.
class ScriptedAgent extends BaseChatModel {
  constructor(private readonly resp: AIMessage) {
    super({} as BaseChatModelParams);
  }
  _llmType(): string {
    return "scripted-agent";
  }
  override bindTools(_tools: unknown[]): this {
    return this;
  }
  async _generate(_messages: unknown[]): Promise<ChatResult> {
    return { generations: [{ message: this.resp, text: typeof this.resp.content === "string" ? this.resp.content : "" }] };
  }
}

describe("compactThread", () => {
  it("compacts a thread into a new thread and writes the summary as the first message", async () => {
    const agentModel = new ScriptedAgent(new AIMessage({ content: "Assist: done" }));
    const agent = createAgent({ model: agentModel, tools: [], checkpointer: new MemorySaver() });

    // run one turn in thread A
    await agent.invoke({ messages: [new HumanMessage("do something")] }, { configurable: { thread_id: "A" } });

    const summarizer = new ScriptedSummarizer("This is the summary.");

    const res = await compactThread(agent, summarizer, "A", "B");
    expect(res.messageCount).toBeGreaterThan(0);
    expect(res.summary).toBe("This is the summary.");

    const state = await agent.getState({ configurable: { thread_id: "B" } });
    const msgs = (state.values as { messages?: unknown[] }).messages ?? [];
    expect(msgs.length).toBeGreaterThan(0);
    const first = msgs[0] as { _getType?: () => string; content?: unknown } | undefined;
    expect(first?._getType && first._getType()).toBe("human");
    expect(typeof first?.content === "string" ? first.content : "").toContain("[Summary of the previous conversation]\nThis is the summary.");
  });

  it("handles Anthropic-style array content blocks in the summarizer response", async () => {
    const agentModel = new ScriptedAgent(new AIMessage({ content: "Assist: done" }));
    const agent = createAgent({ model: agentModel, tools: [], checkpointer: new MemorySaver() });

    // run one turn in thread A
    await agent.invoke({ messages: [new HumanMessage("do something")] }, { configurable: { thread_id: "A" } });

    // Summarizer returns Anthropic-style content blocks (array of objects)
    const summarizer = new ScriptedSummarizer(
      [{ type: "text", text: "Summary from blocks." }, { type: "tool_use", name: "unrelated" }] as unknown as string,
    );

    const res = await compactThread(agent, summarizer, "A", "B");
    expect(res.messageCount).toBeGreaterThan(0);
    expect(res.summary).toBe("Summary from blocks.");
  });

  it("reports usage via onUsage callback (AC-62a side-channel accounting)", async () => {
    const agentModel = new ScriptedAgent(new AIMessage({ content: "Assist: done" }));
    const agent = createAgent({ model: agentModel, tools: [], checkpointer: new MemorySaver() });

    await agent.invoke({ messages: [new HumanMessage("do something")] }, { configurable: { thread_id: "A" } });

    // Summarizer returns a message with usage_metadata including cache_read
    const summarizer = new ScriptedSummarizer("summary text");
    // Override _generate to include usage_metadata
    const origGenerate = summarizer._generate.bind(summarizer);
    summarizer._generate = async (msgs: unknown[]) => {
      const result = await origGenerate(msgs);
      // Inject usage_metadata into the message
      const msg = result.generations[0]!.message as AIMessage;
      (msg as any).usage_metadata = {
        input_tokens: 35,
        output_tokens: 12,
        input_token_details: { cache_read: 20 },
      };
      return result;
    };

    let reported: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
    const res = await compactThread(agent, summarizer as unknown as BaseChatModel, "A", "B", (u) => (reported = u));
    expect(res.messageCount).toBeGreaterThan(0);
    expect(reported).toEqual({ inputTokens: 35, outputTokens: 12, cachedInputTokens: 20 });
  });
});
