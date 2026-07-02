import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSessionStore, resolveSessionRef } from "./sessions.js";

describe("SessionStore", () => {
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

  it("creates directory and DB file on open", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "data", "sessions.db");
    const store = openSessionStore(dbPath);
    expect(store).toBeDefined();
    store.close();
  });

  it("register and list ordering and latest/has", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const a = store.newSessionId();
    const b = store.newSessionId();
    store.register(a);
    store.register(b);
    const list = store.list();
    expect(list.length).toBe(2);
    // newest-first by updatedAt -> b should be newest because registered later
    const first = list[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("missing first");
    expect(first.id).toBe(b);
    const lat = store.latest();
    expect(lat).toBeDefined();
    if (!lat) throw new Error("missing latest");
    expect(lat).toBe(b);
    expect(store.has(a)).toBe(true);
    expect(store.has("nope")).toBe(false);
    store.close();
  });

  it("touch sets preview once and accumulates tokens", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const id = store.newSessionId();
    store.register(id);
    store.touch(id, "first\nline\nmore", { inputTokens: 1, outputTokens: 2 });
    const one = store.list().find((r) => r.id === id);
    expect(one).toBeDefined();
    if (!one) throw new Error("missing session");
    expect(one.preview).toBe("first line more");
    expect(one.inputTokens).toBe(1);
    expect(one.outputTokens).toBe(2);
    // second touch with different preview should not overwrite preview
    store.touch(id, "ignored preview", { inputTokens: 3, outputTokens: 4 });
    const two = store.list().find((r) => r.id === id);
    expect(two).toBeDefined();
    if (!two) throw new Error("missing session");
    expect(two.preview).toBe("first line more");
    expect(two.inputTokens).toBe(4);
    expect(two.outputTokens).toBe(6);
    store.close();
  });

  it("resolveSessionRef handles index, exact, substring, ambiguous, none", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const a = "s-aaa";
    const b = "s-bbb";
    const c = "s-abc";
    store.register(a);
    store.register(b);
    store.register(c);
    const list = store.list();
    // list is newest-first; c registered last
    expect(list[0]).toBeDefined();
    if (!list[0]) throw new Error("missing session");
    expect(list[0].id).toBe(c);

    // index 1 -> c
    const r1 = resolveSessionRef("1", list);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.id).toBe(c);

    // exact id
    const rex = resolveSessionRef(b, list);
    expect(rex.ok).toBe(true);
    if (rex.ok) expect(rex.id).toBe(b);

    // unique substring ("aa" matches s-aaa only)
    const rs = resolveSessionRef("aa", list);
    expect(rs.ok).toBe(true);
    if (rs.ok) expect(rs.id).toBe(a);

    // ambiguous ("b" matches s-bbb and s-abc)
    const ra = resolveSessionRef("b", list);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.message).toContain("ambiguous");

    // none
    const rn = resolveSessionRef("nope", list);
    expect(rn.ok).toBe(false);
    if (!rn.ok) expect(rn.message).toContain("no session matching");

    store.close();
  });
});
