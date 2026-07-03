import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { fingerprintError, openMemoryStore } from "./memory.js";
import type { MemoryRow } from "./memory.js";

describe("memory store", () => {
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

  it("fingerprintError is deterministic and path-insensitive", () => {
    const a = `TypeError: Cannot read property 'x' of undefined at /home/user/project/src/index.js:123:45`;
    const b = `TypeError: Cannot read property 'x' of undefined at ../project/src/index.js:200:10`;
    const c = `ValueError: something else totally different`;
    const fa = fingerprintError(a);
    const fb = fingerprintError(b);
    const fc = fingerprintError(c);
    expect(fa).toBeDefined();
    expect(fb).toBeDefined();
    expect(fc).toBeDefined();
    expect(fa).toBe(fb);
    expect(fa).not.toBe(fc);

    // regression test: ECONNREFUSED with different roots and line:col must fingerprint equal
    const p1 = "Error: connect ECONNREFUSED 127.0.0.1:8443 at /home/kevin/repo/cody/src/tools/mcp.ts:42:11";
    const p2 = "Error: connect ECONNREFUSED 127.0.0.1:8443 at /tmp/other/checkout/src/tools/mcp.ts:87:5";
    const fp1 = fingerprintError(p1);
    const fp2 = fingerprintError(p2);
    expect(fp1).toBe(fp2);
  });

  it("openMemoryStore records failure events and aggregates topFingerprints", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);
    const db = new Database(dbPath);

    // insert two failures with same fingerprint and one different
    const ts = new Date().toISOString();
    const f1 = fingerprintError("Error: boom at /tmp/file1:12:1");
    const f2 = fingerprintError("Error: boom at /tmp/file2:20:2");
    const f3 = fingerprintError("OtherError: failure at /var/log/x");
    store.recordFailureEvent({ ts, fingerprint: f1, errorText: "Error: boom at /tmp/file1:12:1" });
    store.recordFailureEvent({ ts, fingerprint: f2, errorText: "Error: boom at /tmp/file2:20:2" });
    store.recordFailureEvent({ ts, fingerprint: f3, errorText: "OtherError: failure at /var/log/x" });

    // topFingerprints limit 2 should group f1/f2 together
    const top = store.topFingerprints(2);
    expect(top.length).toBeLessThanOrEqual(2);
    // first fingerprint should be the boom one with count 2
    const first = top[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("missing first");
    expect(first.count).toBe(2);

    const total = store.failureCount();
    expect(total).toBe(3);
    const distinct = store.distinctFingerprintCount();
    expect(distinct).toBe(2);

    store.close();
    db.close();
  });

  it("insertMemory dedupes and recallByFingerprint / demotion works", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    const id1 = store.insertMemory({ kind: "failure", cue: "fp-123", triggerText: "ls failed", body: "lesson 1" });
    expect(typeof id1).toBe("number");
    const id2 = store.insertMemory({ kind: "failure", cue: "fp-123", triggerText: "ls failed again", body: "lesson 1" });
    expect(id2).toBe(id1);

    // recall returns the memory
    const recalled = store.recallByFingerprint("fp-123");
    expect(recalled).toBeDefined();
    expect(recalled?.id).toBe(id1);

    // demote to 0 confidence and ensure recall returns undefined
    store.decrementConfidence(id1, 10);
    const recalled2 = store.recallByFingerprint("fp-123");
    expect(recalled2).toBeUndefined();

    store.close();
  });

  it("recallByText finds by trigger_text or body and excludes demoted rows", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    const id1 = store.insertMemory({ kind: "decision", cue: "topic-x", triggerText: "use foobar tool", body: "do this" });
    const id2 = store.insertMemory({ kind: "decision", cue: "topic-y", triggerText: "use other", body: "use foobar sometimes" });

    const res = store.recallByText("foobar", "decision", 5);
    expect(res.length).toBeGreaterThanOrEqual(1);
    const ids = res.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    // demote id1 and ensure it's excluded
    store.decrementConfidence(id1, 10);
    const res2 = store.recallByText("foobar", "decision", 5);
    const ids2 = res2.map((r) => r.id);
    expect(ids2).not.toContain(id1);

    store.close();
  });

  it("recallByText multi-word FTS matches and regresses previous bug", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    const id = store.insertMemory({ kind: "failure", cue: "fp-proxy", triggerText: "pnpm add timed out behind proxy", body: "pnpm add exceeds the 60s shell timeout behind the DKFZ proxy" });
    // OR semantics: at least one matching token should recall the memory
    const res = store.recallByText("proxy timeout", "failure", 5);
    expect(res.length).toBeGreaterThanOrEqual(1);
    const ids = res.map((r) => r.id);
    expect(ids).toContain(id);

    // a multi-word query with no shared terms should return []
    const resNone = store.recallByText("kubernetes helm chart", "failure", 5);
    expect(resNone.length).toBe(0);

    store.close();
  });

  it("touchUsed increments uses", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    const id = store.insertMemory({ kind: "milestone", cue: "m1", triggerText: "done", body: "completed" });
    const before = store.listMemories().find((r) => r.id === id) as MemoryRow;
    expect(before.uses).toBe(0);
    store.touchUsed(id, new Date().toISOString());
    const after = store.listMemories().find((r) => r.id === id) as MemoryRow;
    expect(after.uses).toBeGreaterThanOrEqual(1);

    store.close();
  });

  it("stopwords-only queries do not recall decision memories", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    const id = store.insertMemory({ kind: "decision", cue: "topic-d", triggerText: "default model gpt-5-mini", body: "We chose gpt-5-mini as the default model." });
    const resStop = store.recallByText("list the files in it", "decision", 5);
    expect(resStop.length).toBe(0);

    const resContent = store.recallByText("default model", "decision", 5);
    expect(resContent.length).toBeGreaterThanOrEqual(1);
    const ids = resContent.map((r) => r.id);
    expect(ids).toContain(id);

    store.close();
  });
});
