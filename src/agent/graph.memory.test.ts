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

  it("recalls a provisional memory only within its own session", () => {
    const dbPath = join(wd, "mem-provisional.db");
    const store = openMemoryStore(dbPath);
    store.insertMemory({
      kind: "decision",
      cue: "cache-warmup",
      triggerText: "pre-warm the cache",
      body: "always pre-warm the cache before benchmarking",
      status: "provisional",
      origin: "agent",
      sourceSession: "S",
    });

    const base = "base system prompt";
    const messages = [new HumanMessage("Should we pre-warm the cache before benchmarking?")];

    const inSession = buildMemoryPrompt(base, store, () => "S", { messages });
    const inSessionTxt = (inSession[0] as SystemMessage).text ?? "";
    expect(inSessionTxt).toContain("always pre-warm the cache before benchmarking");

    const crossSession = buildMemoryPrompt(base, store, () => "OTHER", { messages });
    const crossSessionTxt = (crossSession[0] as SystemMessage).text ?? "";
    expect(crossSessionTxt).not.toContain("always pre-warm the cache before benchmarking");

    store.close();
  });

  it("recalls an active memory regardless of the current session", () => {
    const dbPath = join(wd, "mem-active.db");
    const store = openMemoryStore(dbPath);
    store.insertMemory({
      kind: "decision",
      cue: "retry-policy",
      triggerText: "retry failed requests",
      body: "always retry failed network requests three times",
      status: "active",
    });

    const base = "base system prompt";
    const messages = [new HumanMessage("What is our policy on retrying failed requests?")];

    const sameSession = buildMemoryPrompt(base, store, () => "S", { messages });
    expect((sameSession[0] as SystemMessage).text ?? "").toContain(
      "always retry failed network requests three times",
    );

    const otherSession = buildMemoryPrompt(base, store, () => "OTHER", { messages });
    expect((otherSession[0] as SystemMessage).text ?? "").toContain(
      "always retry failed network requests three times",
    );

    store.close();
  });
});
