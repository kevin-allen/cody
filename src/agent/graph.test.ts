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
import { createAgent, runAgentOnce } from "./graph.js";

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
    confirm: () => Promise.resolve(true),
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
