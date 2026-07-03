import { describe, it, expect } from "vitest";
import { consolidate } from "./consolidate.js";
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
