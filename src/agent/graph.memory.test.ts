import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryPrompt } from "./graph.js";
import { openMemoryStore } from "../memory.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

describe("agent memory prompt builder", () => {
  let wd = mkdtempSync(join(tmpdir(), "cody-graph-mem-"));
  afterEach(() => {
    try {
      rmSync(wd, { recursive: true, force: true });
    } catch {}
  });

  it("injects decision memories into the system prompt when human mentions default model", () => {
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);
    const id = store.insertMemory({ kind: "decision", cue: "model-choice", triggerText: "choose gpt model", body: "We chose gpt-5-mini as the default model" });

    const base = "base system prompt";
    const messages = [new HumanMessage("What is the default model?" )];
    const out = buildMemoryPrompt(base, store, () => "sess-1", { messages });
    const system = out[0];
    expect(system).toBeInstanceOf(SystemMessage);
    const txt = (system as SystemMessage).text ?? "";
    expect(txt).toContain("[memory #");
    expect(txt).toContain("We chose gpt-5-mini as the default model");

    store.close();
  });
});
