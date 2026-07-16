import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { resolveConfig } from "../config.js";
import type { ToolContext } from "../tools/index.js";
import { READ_ONLY_TOOL_NAMES, createSubagentTool } from "./subagent.js";
import { SUBAGENT_TAG } from "./graph.js";
import type { UsageTotals } from "./graph.js";

// ---- fake models -----------------------------------------------------------

/** A minimal chat model that returns a scripted sequence of AI messages. */
class ScriptedModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly responses: AIMessage[]) {
    super({} as BaseChatModelParams);
  }
  _llmType(): string {
    return "scripted-subagent";
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

/** A scripted model that records the run tags its calls carry. */
class TagRecordingModel extends ScriptedModel {
  seenTags: string[] = [];
  override async invoke(input: never, config?: { tags?: string[] }) {
    this.seenTags.push(...(config?.tags ?? []));
    return super.invoke(input, config);
  }
}

/** A model that throws when invoked. */
class ThrowingModel extends BaseChatModel {
  constructor(private readonly message: string) {
    super({} as BaseChatModelParams);
  }
  _llmType(): string {
    return "throwing-subagent";
  }
  override bindTools(_tools: unknown[]): this {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    throw new Error(this.message);
  }
}

// ---- helpers ---------------------------------------------------------------

let wd: string;
beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), "cody-subagent-"));
});
afterEach(() => rmSync(wd, { recursive: true, force: true }));

function ctx(mode: "auto" | "readonly" | "supervised", overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workdir: wd,
    config: resolveConfig({ env: { CODY_MODE: mode } }),
    confirm: () => Promise.resolve({ approved: true as const }),
    ...overrides,
  };
}

// ---- tests -----------------------------------------------------------------

describe("READ_ONLY_TOOL_NAMES", () => {
  it("contains only read-only tools and excludes write/edit/shell/remember/subagent", () => {
    expect(READ_ONLY_TOOL_NAMES.has("read_file")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("list_dir")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("glob")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("grep")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("load_skill")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("read_skill_file")).toBe(true);

    // Excluded tools:
    expect(READ_ONLY_TOOL_NAMES.has("write_file")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("edit_file")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("run_shell")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("remember")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("run_subagent")).toBe(false);
  });
});

describe("run_subagent tool", () => {
  it("returns the fake model's final text", async () => {
    const model = new ScriptedModel([
      new AIMessage({ content: "Findings: file foo.ts contains the main logic." }),
    ]);
    const tool = createSubagentTool({ model, ctx: ctx("auto") });

    const result = await tool.invoke({ task: "find the main logic file" });
    expect(typeof result).toBe("string");
    expect(result).toContain("Findings: file foo.ts contains the main logic.");
  });

  it("truncates output > 8000 characters with a marker", async () => {
    // Build a string just over 8000 chars.
    const longText = "x".repeat(8100);
    const model = new ScriptedModel([new AIMessage({ content: longText })]);
    const tool = createSubagentTool({ model, ctx: ctx("auto") });

    const result = await tool.invoke({ task: "generate a long report" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThanOrEqual(8000);
    expect(result).toContain("[subagent report truncated]");
  });

  it("does not truncate output at exactly 8000 characters", async () => {
    const exactText = "y".repeat(8000);
    const model = new ScriptedModel([new AIMessage({ content: exactText })]);
    const tool = createSubagentTool({ model, ctx: ctx("auto") });

    const result = await tool.invoke({ task: "generate a report" });
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[subagent report truncated]");
    expect(result.length).toBe(8000);
  });

  it("reports usage via onUsage with summed token counts", async () => {
    // Build an AI message with usage_metadata.
    const msg = new AIMessage({
      content: "Done.",
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    } as any);
    const model = new ScriptedModel([msg]);

    const collected: UsageTotals[] = [];
    const tool = createSubagentTool({
      model,
      ctx: ctx("auto"),
      onUsage: (u) => collected.push(u),
    });

    await tool.invoke({ task: "do something" });
    expect(collected.length).toBe(1);
    expect(collected[0]!.inputTokens).toBe(100);
    expect(collected[0]!.outputTokens).toBe(50);
    expect(collected[0]!.cachedInputTokens).toBe(0);
    expect(collected[0]!.contextTokens).toBe(100);
  });

  it("runs the sub-agent with SUBAGENT_TAG so its chunks are filtered from the parent stream", async () => {
    const model = new TagRecordingModel([new AIMessage("report")]);
    const tool = createSubagentTool({ model, ctx: ctx("auto") });

    await tool.invoke({ task: "explore" });
    expect(model.seenTags).toContain(SUBAGENT_TAG);
  });

  it("returns [denied] in readonly mode without invoking the model", async () => {
    // Use a model that would throw if invoked, to prove it's never called.
    const model = new ThrowingModel("should not be called");
    const tool = createSubagentTool({ model, ctx: ctx("readonly") });

    const result = await tool.invoke({ task: "explore" });
    expect(typeof result).toBe("string");
    expect(result).toContain("[denied]");
  });

  it("calls confirm() once in supervised mode and runs when approved", async () => {
    let callCount = 0;
    const confirm = async () => {
      callCount++;
      return { approved: true as const };
    };
    const model = new ScriptedModel([
      new AIMessage({ content: "Report: found 3 files." }),
    ]);
    const tool = createSubagentTool({ model, ctx: ctx("supervised", { confirm }) });

    const result = await tool.invoke({ task: "explore" });
    expect(callCount).toBe(1);
    expect(result).toContain("Report: found 3 files.");
  });

  it("returns [denied by user] in supervised mode when confirm returns false", async () => {
    const confirm = async () => ({ approved: false as const, reason: "not now" });
    const model = new ThrowingModel("should not be called");
    const tool = createSubagentTool({ model, ctx: ctx("supervised", { confirm }) });

    const result = await tool.invoke({ task: "explore" });
    expect(result).toContain("[denied by user");
  });

  it("returns [error] when the model throws", async () => {
    const model = new ThrowingModel("network timeout");
    const tool = createSubagentTool({ model, ctx: ctx("auto") });

    const result = await tool.invoke({ task: "explore" });
    expect(typeof result).toBe("string");
    expect(result).toContain("[error] subagent failed: network timeout");
  });

  it("truncates task preview to ~200 chars in the gate approval", async () => {
    // Use supervised to observe the gate preview via confirm's ApprovalRequest.
    let previewSeen = "";
    const confirm = async (req: import("../tools/index.js").ApprovalRequest) => {
      previewSeen = req.preview;
      return { approved: true as const };
    };
    const model = new ScriptedModel([new AIMessage({ content: "ok" })]);
    const tool = createSubagentTool({ model, ctx: ctx("supervised", { confirm }) });

    const longTask = "a".repeat(250);
    await tool.invoke({ task: longTask });
    expect(previewSeen.length).toBeLessThanOrEqual(203); // 200 + "..." allowance
    expect(previewSeen).toContain("...");
  });
});
