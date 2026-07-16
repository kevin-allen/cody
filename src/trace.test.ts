import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { openTrace } from "./trace.js";
import type { TraceHandle } from "./trace.js";

function fakeLLMResult(text: string, usage?: Record<string, unknown>): LLMResult {
  const msg = { content: text, usage_metadata: usage };
  return {
    generations: [[{ text, message: msg } as unknown as import("@langchain/core/outputs").Generation]],
    llmOutput: {},
  };
}

describe("openTrace", () => {
  let dir: string;
  let trace: TraceHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cody-trace-"));
  });

  afterEach(() => {
    try {
      trace?.close();
    } catch {
      // ignore
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes call / result / event rows and file is valid gzip JSONL", () => {
    trace = openTrace(dir);
    expect(existsSync(trace.path)).toBe(true);

    const serialized = {} as unknown as Serialized;
    const msgs: BaseMessage[][] = [
      [new HumanMessage("hello")],
    ];

    // Drive the handler directly
    void trace.handler.handleChatModelStart!(
      serialized,
      msgs,
      "run-1",
      undefined,
      undefined,
      ["test-tag"],
    );

    void trace.handler.handleLLMEnd!(
      fakeLLMResult("world", { input_tokens: 10, output_tokens: 5 }),
      "run-1",
    );

    trace.event("eviction", { evictedIds: ["id1", "id2"] });

    trace.close();

    // Read and decompress
    const raw = readFileSync(trace.path);
    const decompressed = gunzipSync(raw).toString("utf8");
    const lines = decompressed.trim().split("\n");
    expect(lines.length).toBe(3);

    const r1 = JSON.parse(lines[0]!);
    expect(r1.kind).toBe("call");
    expect(r1.runId).toBe("run-1");
    expect(r1.tags).toEqual(["test-tag"]);
    expect(r1.messages[0][0].role).toBe("human");
    expect(r1.messages[0][0].content).toBe("hello");

    const r2 = JSON.parse(lines[1]!);
    expect(r2.kind).toBe("result");
    expect(r2.runId).toBe("run-1");
    expect(r2.text).toBe("world");
    expect(r2.usage_metadata).toEqual({ input_tokens: 10, output_tokens: 5 });

    const r3 = JSON.parse(lines[2]!);
    expect(r3.kind).toBe("eviction");
    expect(r3.evictedIds).toEqual(["id1", "id2"]);
  });

  it("rows carry sessionId after setSession", () => {
    trace = openTrace(dir);
    trace.setSession("sess-abc");

    const serialized = {} as unknown as Serialized;
    const msgs: BaseMessage[][] = [[new AIMessage("ok")]];

    void trace.handler.handleChatModelStart!(serialized, msgs, "run-2");
    trace.event("custom", { foo: "bar" });
    trace.close();

    const raw = readFileSync(trace.path);
    const decompressed = gunzipSync(raw).toString("utf8");
    const lines = decompressed.trim().split("\n");

    // sessionId undefined → omit from JSON? No, it's set explicitly.
    // Actually we set it, so both rows should have it.
    expect(JSON.parse(lines[0]!).sessionId).toBe("sess-abc");
    expect(JSON.parse(lines[1]!).sessionId).toBe("sess-abc");
  });

  it("sessionId starts undefined, then updates on setSession", () => {
    trace = openTrace(dir);

    const serialized = {} as unknown as Serialized;
    const msgs: BaseMessage[][] = [[new AIMessage("first")]];

    void trace.handler.handleChatModelStart!(serialized, msgs, "run-3");
    trace.setSession("sess-xyz");
    void trace.handler.handleChatModelStart!(serialized, msgs, "run-4");
    trace.close();

    const raw = readFileSync(trace.path);
    const decompressed = gunzipSync(raw).toString("utf8");
    const lines = decompressed.trim().split("\n");

    // First row: sessionId is null (omitted in JSON — wait, it's undefined which JSON.stringify omits)
    expect(JSON.parse(lines[0]!).sessionId).toBeUndefined();
    // Second row: sessionId is set
    expect(JSON.parse(lines[1]!).sessionId).toBe("sess-xyz");
  });

  it("handler swallows errors on invalid output (no generations)", () => {
    trace = openTrace(dir);
    // handleLLMEnd with no generations — shouldn't throw
    expect(() => {
      void trace!.handler.handleLLMEnd!(
        { generations: [], llmOutput: {} },
        "run-5",
      );
    }).not.toThrow();

    // handleChatModelStart with empty messages — shouldn't throw
    expect(() => {
      void trace!.handler.handleChatModelStart!(
        {} as unknown as Serialized,
        [] as unknown as BaseMessage[][],
        "run-6",
      );
    }).not.toThrow();

    trace.close();

    // event after close — shouldn't throw
    expect(() => {
      trace!.event("late", {});
    }).not.toThrow();
  });
});
