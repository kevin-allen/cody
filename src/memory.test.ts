import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { fingerprintError, openMemoryStore } from "./memory.js";

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
});
