import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consolidate, reviewProvisional, reviewSessionProvisional, consolidateTranscript, findOrphanedSessions } from "./consolidate.js";
import type { ConsolidationRecord, UsageReport } from "./consolidate.js";
import { openMemoryStore } from "./memory.js";

class FakeModelOK {
  constructor(private readonly out: unknown) {}
  async invoke(_msgs: any) {
    return { content: this.out };
  }
}

class FakeModelWithUsage {
  constructor(private readonly out: unknown) {}
  async invoke(_msgs: any) {
    return {
      content: this.out,
      usage_metadata: {
        input_tokens: 42,
        output_tokens: 7,
        input_token_details: { cache_read: 30 },
      },
    };
  }
}

class FakeModelThrows {
  async invoke(_msgs: any) {
    throw new Error("nope");
  }
}

/** Returns a different output on each call; after exhausting outputs returns "[]". */
class FakeModelMulti {
  private calls = 0;
  constructor(private readonly outputs: string[]) {}
  async invoke(_msgs: any) {
    const idx = this.calls++;
    return { content: idx < this.outputs.length ? this.outputs[idx]! : "[]" };
  }
}

describe("consolidate", () => {
  it("parses a plain JSON array response", async () => {
    const out = JSON.stringify([
      { kind: "decision", cue: "test", triggerText: "x", body: "do the thing", confidence: 1 },
    ]);
    const model = new FakeModelOK(out) as any;
    const res = await consolidate(model, "transcript");
    expect(res.length).toBe(1);
    expect(res[0]!.kind).toBe("decision");
    expect(res[0]!.body).toBe("do the thing");
  });

  it("parses fenced and prosy response", async () => {
    const out = "Some commentary\n```json\n" + JSON.stringify([
      { kind: "milestone", cue: "m", body: "done", confidence: 1 },
    ]) + "\n```\nThanks";
    const model = new FakeModelOK(out) as any;
    const res = await consolidate(model, "t");
    expect(res.length).toBe(1);
    expect(res[0]!.kind).toBe("milestone");
  });

  it("returns [] for non-json prose", async () => {
    const model = new FakeModelOK("I did stuff") as any;
    const res = await consolidate(model, "t");
    expect(res.length).toBe(0);
  });

  it("extracts content from Anthropic-style array blocks (FR-15: provider-agnostic content handling)", async () => {
    const out = JSON.stringify([
      { kind: "decision", cue: "from-array", triggerText: "x", body: "works with array blocks", confidence: 1 },
    ]);
    // Simulate Anthropic-style content-block array response
    const model = new FakeModelOK([{ type: "text", text: out }, { type: "tool_use", name: "x" }]) as any;
    const res = await consolidate(model, "transcript");
    expect(res.length).toBe(1);
    expect(res[0]!.cue).toBe("from-array");
  });

  it("drops invalid elements", async () => {
    const arr = [
      { kind: "decision", cue: "a", body: "ok" },
      { kind: "unknown", cue: "b", body: "no" },
      { kind: "failure", cue: "c" },
    ];
    const model = new FakeModelOK(JSON.stringify(arr)) as any;
    const res = await consolidate(model, "t");
    expect(res.length).toBe(1);
    expect(res[0]!.cue).toBe("a");
  });

  it("returns [] when model.invoke throws", async () => {
    const model = new FakeModelThrows() as any;
    const res = await consolidate(model, "t");
    expect(res.length).toBe(0);
  });
});

describe("reviewProvisional", () => {
  it("parses a plain JSON array of verdicts", async () => {
    const out = JSON.stringify([
      { index: 0, verdict: "confirmed" },
      { index: 1, verdict: "wrong" },
    ]);
    const model = new FakeModelOK(out) as any;
    const res = await reviewProvisional(model, "transcript", [
      { index: 0, body: "note a" },
      { index: 1, body: "note b" },
    ]);
    expect(res.length).toBe(2);
    expect(res[0]).toEqual({ index: 0, verdict: "confirmed" });
    expect(res[1]).toEqual({ index: 1, verdict: "wrong" });
  });

  it("parses verdicts wrapped in prose/fences", async () => {
    const out = "Here you go:\n```json\n" + JSON.stringify([{ index: 0, verdict: "unconfirmed" }]) + "\n```\nDone";
    const model = new FakeModelOK(out) as any;
    const res = await reviewProvisional(model, "t", [{ index: 0, body: "note a" }]);
    expect(res.length).toBe(1);
    expect(res[0]).toEqual({ index: 0, verdict: "unconfirmed" });
  });

  it("returns [] for empty items WITHOUT calling the model", async () => {
    const model = new FakeModelThrows() as any;
    const res = await reviewProvisional(model, "t", []);
    expect(res.length).toBe(0);
  });

  it("returns [] when the model returns non-JSON", async () => {
    const model = new FakeModelOK("no idea what you mean") as any;
    const res = await reviewProvisional(model, "t", [{ index: 0, body: "note a" }]);
    expect(res.length).toBe(0);
  });

  it("drops elements with invalid verdict or missing index", async () => {
    const arr = [
      { index: 0, verdict: "confirmed" },
      { index: 1, verdict: "maybe" },
      { verdict: "wrong" },
      { index: "2", verdict: "wrong" },
    ];
    const model = new FakeModelOK(JSON.stringify(arr)) as any;
    const res = await reviewProvisional(model, "t", [
      { index: 0, body: "a" },
      { index: 1, body: "b" },
      { index: 2, body: "c" },
    ]);
    expect(res.length).toBe(1);
    expect(res[0]).toEqual({ index: 0, verdict: "confirmed" });
  });

  it("extracts content from Anthropic-style array blocks", async () => {
    const out = JSON.stringify([
      { index: 0, verdict: "confirmed" },
      { index: 1, verdict: "wrong" },
    ]);
    // Simulate Anthropic-style content-block array response
    const model = new FakeModelOK([{ type: "text", text: out }, { type: "tool_use", name: "x" }]) as any;
    const res = await reviewProvisional(model, "transcript", [
      { index: 0, body: "note a" },
      { index: 1, body: "note b" },
    ]);
    expect(res.length).toBe(2);
    expect(res[0]).toEqual({ index: 0, verdict: "confirmed" });
    expect(res[1]).toEqual({ index: 1, verdict: "wrong" });
  });
});

describe("findOrphanedSessions / reviewSessionProvisional (orphaned provisional memory sweep)", () => {
  let wd = "";
  afterEach(() => {
    if (wd) {
      try {
        rmSync(wd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    wd = "";
  });

  it("findOrphanedSessions returns distinct sourceSessions other than the current one, ignoring unattributed memories", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));

    store.insertMemory({ kind: "decision", cue: "a", body: "from session A", status: "provisional", sourceSession: "A" });
    store.insertMemory({ kind: "failure", cue: "a2", body: "also from A", status: "provisional", sourceSession: "A" });
    store.insertMemory({ kind: "milestone", cue: "b", body: "from session B", status: "provisional", sourceSession: "B" });
    store.insertMemory({ kind: "decision", cue: "c", body: "from the current session", status: "provisional", sourceSession: "CURRENT" });
    store.insertMemory({ kind: "decision", cue: "d", body: "no source session at all", status: "provisional" });
    store.insertMemory({ kind: "decision", cue: "e", body: "active, not provisional", status: "active", sourceSession: "Z" });

    const orphans = findOrphanedSessions(store, "CURRENT");
    expect(orphans.sort()).toEqual(["A", "B"]);

    store.close();
  });

  it("findOrphanedSessions returns everything provisional when there is no current session", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));
    store.insertMemory({ kind: "decision", cue: "a", body: "from A", status: "provisional", sourceSession: "A" });
    const orphans = findOrphanedSessions(store, undefined);
    expect(orphans).toEqual(["A"]);
    store.close();
  });

  it("reviewSessionProvisional promotes confirmed and prunes the rest, using the recovered transcript", async () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));

    const idConfirmed = store.insertMemory({
      kind: "decision",
      cue: "confirmed-one",
      body: "this one was confirmed",
      status: "provisional",
      sourceSession: "orphan-1",
    });
    const idWrong = store.insertMemory({
      kind: "decision",
      cue: "wrong-one",
      body: "this one was wrong",
      status: "provisional",
      sourceSession: "orphan-1",
    });
    // belongs to a different orphaned session; must be untouched by this call
    const idOther = store.insertMemory({
      kind: "decision",
      cue: "other-session",
      body: "belongs to a different session",
      status: "provisional",
      sourceSession: "orphan-2",
    });

    // reviewSessionProvisional passes items in store.listProvisional() order
    // (newest id first) filtered to this session — mirror that ordering here
    // rather than assuming insertion order.
    const order = store.listProvisional().filter((m) => m.sourceSession === "orphan-1");
    expect(order.map((m) => m.id)).toEqual([idWrong, idConfirmed]);
    const out = JSON.stringify([
      { index: order.findIndex((m) => m.id === idConfirmed), verdict: "confirmed" },
      { index: order.findIndex((m) => m.id === idWrong), verdict: "wrong" },
    ]);
    const model = new FakeModelOK(out) as any;

    const result = await reviewSessionProvisional(store, model, "orphan-1", async () => "recovered transcript text");
    expect(result).toEqual({ promoted: 1, pruned: 1 });

    const confirmedRow = store.listMemories().find((m) => m.id === idConfirmed);
    expect(confirmedRow?.status).toBe("active");
    expect(store.listMemories().find((m) => m.id === idWrong)).toBeUndefined();
    expect(store.listProvisional().map((m) => m.id)).toContain(idOther);

    store.close();
  });

  it("reviewSessionProvisional is a no-op when there's nothing provisional for that session", async () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));
    const model = new FakeModelOK("[]") as any;
    const result = await reviewSessionProvisional(store, model, "nobody", async () => "irrelevant");
    expect(result).toEqual({ promoted: 0, pruned: 0 });
    store.close();
  });

  it("reviewSessionProvisional leaves memories untouched when the transcript can't be recovered", async () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));
    const id = store.insertMemory({
      kind: "decision",
      cue: "stuck",
      body: "checkpoint is gone",
      status: "provisional",
      sourceSession: "gone",
    });
    const model = new FakeModelOK(JSON.stringify([{ index: 0, verdict: "confirmed" }])) as any;

    // getTranscript resolves to undefined, simulating a pruned/missing checkpoint
    const result = await reviewSessionProvisional(store, model, "gone", async () => undefined);
    expect(result).toEqual({ promoted: 0, pruned: 0 });
    expect(store.listProvisional().map((m) => m.id)).toContain(id);
    store.close();
  });
});

describe("consolidateTranscript", () => {
  let wd = "";
  afterEach(() => {
    if (wd) {
      try {
        rmSync(wd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    wd = "";
  });

  it("inserts records with origin consolidated and sourceSession set, reviews provisionals, returns correct counts", async () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));

    // Pre-insert a provisional memory for the same session
    const provisionalId = store.insertMemory({
      kind: "decision",
      cue: "provisional-note",
      body: "this should be reviewed",
      status: "provisional",
      sourceSession: "test-session",
    });

    // Model returns one consolidated record on the first call (consolidate),
    // then a verdict confirming the provisional on the second call (reviewProvisional).
    // listProvisional returns ORDER BY id DESC, so the provisional we just inserted
    // (highest id) will be at index 0.
    const out1 = JSON.stringify([
      { kind: "decision", cue: "learned", triggerText: "x", body: "something learned", confidence: 1 },
    ]);
    const out2 = JSON.stringify([
      { index: 0, verdict: "confirmed" },
    ]);
    const model = new FakeModelMulti([out1, out2]) as any;

    const result = await consolidateTranscript(store, model, "test-session", "transcript contents");

    expect(result.inserted).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.pruned).toBe(0);

    // The inserted record should be active with origin "consolidated" and sourceSession set
    const all = store.listMemories();
    const inserted = all.find((m) => m.cue === "learned");
    expect(inserted).toBeTruthy();
    expect(inserted!.sourceSession).toBe("test-session");
    expect(inserted!.origin).toBe("consolidated");
    expect(inserted!.status).toBe("active");

    // The provisional should now be active (promoted)
    const promoted = all.find((m) => m.id === provisionalId);
    expect(promoted?.status).toBe("active");

    store.close();
  });

  it("returns {0,0,0} when the model throws, leaving memory intact", async () => {
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));

    // Pre-insert a provisional memory
    const provisionalId = store.insertMemory({
      kind: "decision",
      cue: "survives",
      body: "should not be touched",
      status: "provisional",
      sourceSession: "test-session",
    });

    const model = new FakeModelThrows() as any;
    const result = await consolidateTranscript(store, model, "test-session", "transcript");

    expect(result).toEqual({ inserted: 0, promoted: 0, pruned: 0 });

    // The provisional memory should still exist untouched
    const prov = store.listProvisional();
    expect(prov.map((m) => m.id)).toContain(provisionalId);

    store.close();
  });

  it("returns {0,0,0} when memory store throws on insert", async () => {
    // Use a real store but close it to force insert errors
    wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));

    const out1 = JSON.stringify([
      { kind: "decision", cue: "doomed", body: "will fail to insert", confidence: 1 },
    ]);
    const model = new FakeModelOK(out1) as any;

    // Close the store before calling so insertMemory throws
    store.close();

    const result = await consolidateTranscript(store, model, "test-session", "transcript");
    expect(result).toEqual({ inserted: 0, promoted: 0, pruned: 0 });
  });
});

describe("onUsage callback (AC-62a side-channel accounting)", () => {
  it("consolidate reports usage via onUsage callback", async () => {
    const out = JSON.stringify([
      { kind: "decision", cue: "test", body: "do the thing", confidence: 1 },
    ]);
    const model = new FakeModelWithUsage(out) as any;
    let reported: UsageReport | undefined;
    const res = await consolidate(model, "transcript", (u) => (reported = u));
    expect(res.length).toBe(1);
    expect(reported).toEqual({ inputTokens: 42, outputTokens: 7, cachedInputTokens: 30 });
  });

  it("reviewProvisional reports usage via onUsage callback", async () => {
    const out = JSON.stringify([{ index: 0, verdict: "confirmed" }]);
    const model = new FakeModelWithUsage(out) as any;
    let reported: UsageReport | undefined;
    const res = await reviewProvisional(model, "transcript", [{ index: 0, body: "note" }], (u) => (reported = u));
    expect(res.length).toBe(1);
    expect(reported).toEqual({ inputTokens: 42, outputTokens: 7, cachedInputTokens: 30 });
  });

  it("consolidateTranscript forwards onUsage to consolidate", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-consolidate-"));
    const store = openMemoryStore(join(wd, "mem.db"));
    const out = JSON.stringify([]);
    const model = new FakeModelWithUsage(out) as any;
    let reported: UsageReport | undefined;
    const result = await consolidateTranscript(store, model, "test-session", "transcript", (u) => (reported = u));
    expect(result.inserted).toBe(0);
    expect(reported).toEqual({ inputTokens: 42, outputTokens: 7, cachedInputTokens: 30 });
    try { rmSync(wd, { recursive: true, force: true }); } catch {}
  });
});
