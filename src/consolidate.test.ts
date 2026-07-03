import { describe, it, expect } from "vitest";
import { consolidate, reviewProvisional } from "./consolidate.js";
import type { ConsolidationRecord } from "./consolidate.js";

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
