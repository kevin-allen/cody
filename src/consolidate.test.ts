import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consolidate, reviewProvisional, reviewSessionProvisional, findOrphanedSessions } from "./consolidate.js";
import type { ConsolidationRecord } from "./consolidate.js";
import { openMemoryStore } from "./memory.js";

class FakeModelOK {
  constructor(private readonly out: string) {}
  async invoke(_msgs: any) {
    return { content: this.out };
  }
}

class FakeModelThrows {
  async invoke(_msgs: any) {
    throw new Error("nope");
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
