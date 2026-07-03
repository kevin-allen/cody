import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { fingerprintError, openMemoryStore, formatMemoryBreakdown } from "./memory.js";
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
    const first = top[0]!;
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
    const rowsBefore = store.listMemories();
    const idxBefore = rowsBefore.findIndex((r) => r.id === id);
    if (idxBefore === -1) throw new Error("missing before");
    const beforeRow = rowsBefore[idxBefore]!;
    expect(beforeRow.uses).toBe(0);
    store.touchUsed(id, new Date().toISOString());
    const rowsAfter = store.listMemories();
    const idxAfter = rowsAfter.findIndex((r) => r.id === id);
    if (idxAfter === -1) throw new Error("missing after");
    const afterRow = rowsAfter[idxAfter]!;
    expect(afterRow.uses).toBeGreaterThanOrEqual(1);

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

  it("topMemories returns only decision & milestone memories and excludes failures/demoted ones", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    // insert a decision memory with confidence 5
    const idHigh = store.insertMemory({ kind: "decision", cue: "d-high", triggerText: "choose high", body: "important decision", confidence: 5 });
    // insert a milestone memory with confidence 2
    const idMilestone = store.insertMemory({ kind: "milestone", cue: "m-low", triggerText: "milestone", body: "a milestone", confidence: 2 });
    // insert a failure memory with high confidence (should be excluded)
    const idFailure = store.insertMemory({ kind: "failure", cue: "f-bad", triggerText: "boom", body: "should be excluded", confidence: 9 });
    // insert a decision memory that will be demoted to 0
    const idDemoted = store.insertMemory({ kind: "decision", cue: "d-demote", triggerText: "later", body: "to be demoted" });
    store.decrementConfidence(idDemoted, 10);

    const top = store.topMemories(8);
    expect(top.length).toBe(2);
    const ids = top.map((r) => r.id);
    // should contain high decision and milestone
    expect(ids).toContain(idHigh);
    expect(ids).toContain(idMilestone);
    // should NOT contain failure or demoted
    expect(ids).not.toContain(idFailure);
    expect(ids).not.toContain(idDemoted);

    // ordering: highest confidence first
    const firstTop = top[0]!;
    const secondTop = top[1]!;
    expect(firstTop.confidence).toBeGreaterThan(secondTop.confidence);

    // ensure only decision/milestone kinds present
    for (const m of top) {
      expect(["decision", "milestone"]).toContain(m.kind);
      expect(m.confidence).toBeGreaterThan(0);
    }

    store.close();
  });

  it("provisional memories are session-scoped for recall, excluded from topMemories, and promotable", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    // an existing active/NULL-status memory recalls regardless of currentSession
    const idActiveDecision = store.insertMemory({ kind: "decision", cue: "active-topic", triggerText: "use widget tool", body: "we use the widget tool", confidence: 5 });
    const activeAnySession = store.recallByText("widget", "decision", 5, "B");
    expect(activeAnySession.map((r) => r.id)).toContain(idActiveDecision);
    const activeNoSession = store.recallByText("widget", "decision", 5);
    expect(activeNoSession.map((r) => r.id)).toContain(idActiveDecision);

    // insert a provisional failure memory sourced from session 'A'
    const fp = "fp-provisional-1";
    const idProv = store.insertMemory({
      kind: "failure",
      cue: fp,
      triggerText: "gizmo failed to start",
      body: "restart the gizmo daemon",
      status: "provisional",
      sourceSession: "A",
    });

    // recallByText: matches for the originating session, not for another/omitted session
    const byTextA = store.recallByText("gizmo", "failure", 5, "A");
    expect(byTextA.map((r) => r.id)).toContain(idProv);
    const byTextB = store.recallByText("gizmo", "failure", 5, "B");
    expect(byTextB.map((r) => r.id)).not.toContain(idProv);
    const byTextNone = store.recallByText("gizmo", "failure", 5);
    expect(byTextNone.map((r) => r.id)).not.toContain(idProv);

    // recallByFingerprint: same session-scoping behavior
    const byFpA = store.recallByFingerprint(fp, "A");
    expect(byFpA?.id).toBe(idProv);
    const byFpB = store.recallByFingerprint(fp, "B");
    expect(byFpB).toBeUndefined();
    const byFpNone = store.recallByFingerprint(fp);
    expect(byFpNone).toBeUndefined();

    // provisional memory never appears in topMemories, even if it were decision/milestone-kind
    const idProvDecision = store.insertMemory({
      kind: "decision",
      cue: "prov-decision",
      triggerText: "provisional decision",
      body: "not yet confirmed",
      status: "provisional",
      sourceSession: "A",
      confidence: 9,
    });
    const top = store.topMemories(20);
    expect(top.map((r) => r.id)).not.toContain(idProvDecision);

    // promote the provisional decision memory: now recalls from any session and appears in topMemories
    store.promoteMemory(idProvDecision);
    const afterPromoteAnySession = store.recallByText("provisional decision", "decision", 5, "B");
    expect(afterPromoteAnySession.map((r) => r.id)).toContain(idProvDecision);
    const afterPromoteNoSession = store.recallByText("provisional decision", "decision", 5);
    expect(afterPromoteNoSession.map((r) => r.id)).toContain(idProvDecision);
    const topAfter = store.topMemories(20);
    expect(topAfter.map((r) => r.id)).toContain(idProvDecision);

    // promoteMemory with an explicit confidence sets it
    const idProvConfidence = store.insertMemory({
      kind: "decision",
      cue: "prov-confidence",
      triggerText: "confidence bump",
      body: "should end with confidence 7",
      status: "provisional",
      sourceSession: "A",
      confidence: 1,
    });
    store.promoteMemory(idProvConfidence, 7);
    const promoted = store.listMemories().find((r) => r.id === idProvConfidence);
    expect(promoted?.status).toBe("active");
    expect(promoted?.confidence).toBe(7);

    // listProvisional returns only provisional rows
    const idProv2 = store.insertMemory({
      kind: "failure",
      cue: "fp-provisional-2",
      triggerText: "another provisional",
      body: "temp lesson",
      status: "provisional",
      sourceSession: "A",
    });
    const provisionalRows = store.listProvisional();
    const provisionalIds = provisionalRows.map((r) => r.id);
    expect(provisionalIds).toContain(idProv);
    expect(provisionalIds).toContain(idProv2);
    expect(provisionalIds).not.toContain(idActiveDecision);
    expect(provisionalIds).not.toContain(idProvDecision); // was promoted above
    for (const r of provisionalRows) {
      expect(r.status).toBe("provisional");
    }

    // pruneProvisional deletes the row
    store.pruneProvisional(idProv2);
    const afterPrune = store.listMemories().find((r) => r.id === idProv2);
    expect(afterPrune).toBeUndefined();
    expect(store.listProvisional().map((r) => r.id)).not.toContain(idProv2);

    store.close();
  });

  it("originStatusBreakdown groups by origin/status and tallies recalled counts", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const dbPath = join(wd, "mem.db");
    const store = openMemoryStore(dbPath);

    // consolidated/active (default origin/status)
    const idConsolidated = store.insertMemory({ kind: "decision", cue: "c-1", triggerText: "consolidated one", body: "consolidated lesson" });
    // user/active
    const idUser = store.insertMemory({ kind: "decision", cue: "u-1", triggerText: "user one", body: "user note", origin: "user", status: "active" });
    // agent/provisional
    const idAgent = store.insertMemory({ kind: "failure", cue: "a-1", triggerText: "agent one", body: "agent lesson", origin: "agent", status: "provisional", sourceSession: "S" });

    // recall (touch) only the consolidated one
    store.touchUsed(idConsolidated, new Date().toISOString());

    const breakdown = store.originStatusBreakdown();
    // sanity: ids exist (avoids unused-var lint while documenting intent)
    expect([idConsolidated, idUser, idAgent].every((id) => typeof id === "number")).toBe(true);

    const consolidatedActive = breakdown.find((r) => r.origin === "consolidated" && r.status === "active");
    expect(consolidatedActive).toBeDefined();
    expect(consolidatedActive?.count).toBe(1);
    expect(consolidatedActive?.recalled).toBe(1);

    const userActive = breakdown.find((r) => r.origin === "user" && r.status === "active");
    expect(userActive).toBeDefined();
    expect(userActive?.count).toBe(1);
    expect(userActive?.recalled).toBe(0);

    const agentProvisional = breakdown.find((r) => r.origin === "agent" && r.status === "provisional");
    expect(agentProvisional).toBeDefined();
    expect(agentProvisional?.count).toBe(1);
    expect(agentProvisional?.recalled).toBe(0);

    // sorted by origin then status
    const order = breakdown.map((r) => `${r.origin}/${r.status}`);
    const sorted = [...order].sort();
    expect(order).toEqual(sorted);

    store.close();
  });

  it("formatMemoryBreakdown renders grouped lines and handles the empty case", () => {
    const rendered = formatMemoryBreakdown([
      { origin: "consolidated", status: "active", count: 3, recalled: 2 },
      { origin: "user", status: "active", count: 1, recalled: 0 },
    ]);
    expect(rendered).toBe(
      "memories by origin/status:\n consolidated/active: 3 (2 recalled)\n user/active: 1 (0 recalled)",
    );

    expect(formatMemoryBreakdown([])).toBe("memories by origin/status: (none)");
  });
});
