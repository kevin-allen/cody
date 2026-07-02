import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openSessionStore, resolveSessionRef, sanitizeTitle } from "./sessions.js";

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

  it("migration adds title column and setTitle works on old DBs", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    // create old-style DB without title column
    const db = new Database(dbPath);
    db.prepare(`CREATE TABLE IF NOT EXISTS cody_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      preview TEXT DEFAULT '' ,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0
    )`).run();
    const id = 's-old';
    const now = new Date().toISOString();
    db.prepare("INSERT INTO cody_sessions(id, created_at, updated_at, preview, input_tokens, output_tokens) VALUES (?, ?, ?, ?, 0, 0)").run(id, now, now, 'p');
    db.close();

    const store = openSessionStore(dbPath);
    // set title should work
    store.setTitle(id, '  "My\nTitle"  ');
    const one = store.list().find((r) => r.id === id);
    expect(one).toBeDefined();
    if (!one) throw new Error('missing session');
    expect(one.title).toBe('My Title');
    store.close();
  });

  it("setTitle caps and no-ops for unknown id", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const id = store.newSessionId();
    store.register(id);
    const long = 'a'.repeat(100);
    store.setTitle(id, long);
    const one = store.list().find((r) => r.id === id);
    expect(one).toBeDefined();
    if (!one) throw new Error('missing session');
    expect(one.title.length).toBe(60);
    // unknown id no-op
    store.setTitle('nope', 'x');
    store.close();
  });

  it("sanitizeTitle handles whitespace, quotes, trim and cap", () => {
    expect(sanitizeTitle('  hello   world\n ')).toBe('hello world');
    expect(sanitizeTitle('"quoted title"')).toBe('quoted title');
    expect(sanitizeTitle("'single' ")).toBe('single');
    const big = 'a'.repeat(100);
    expect(sanitizeTitle(big).length).toBe(60);
  });

  it("pruneCheckpoints deletes old checkpoints and writes", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const db = new Database(dbPath);
    // create checkpoints and writes tables
    db.prepare('CREATE TABLE IF NOT EXISTS checkpoints (thread_id TEXT, checkpoint_id TEXT)').run();
    db.prepare('CREATE TABLE IF NOT EXISTS writes (thread_id TEXT, checkpoint_id TEXT)').run();
    // insert checkpoints for t1: c1, c2, c3 (c3 is lexicographic max)
    db.prepare('INSERT INTO checkpoints(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c1');
    db.prepare('INSERT INTO checkpoints(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c2');
    db.prepare('INSERT INTO checkpoints(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c3');
    // another thread
    db.prepare('INSERT INTO checkpoints(thread_id, checkpoint_id) VALUES (?, ?)').run('t2', 'a1');
    // writes for all
    db.prepare('INSERT INTO writes(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c1');
    db.prepare('INSERT INTO writes(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c2');
    db.prepare('INSERT INTO writes(thread_id, checkpoint_id) VALUES (?, ?)').run('t1', 'c3');
    db.prepare('INSERT INTO writes(thread_id, checkpoint_id) VALUES (?, ?)').run('t2', 'a1');

    const deleted = store.pruneCheckpoints('t1');
    expect(deleted).toBe(2);
    // remaining checkpoint for t1 should be c3
    const row = db.prepare("SELECT checkpoint_id FROM checkpoints WHERE thread_id = ?").get('t1') as { checkpoint_id: string };
    expect(row.checkpoint_id).toBe('c3');
    // writes for c1/c2 deleted, c3 and t2 remain
    const w1 = db.prepare("SELECT COUNT(*) as cnt FROM writes WHERE thread_id = ? AND checkpoint_id = ?").get('t1', 'c1') as { cnt: number };
    const w2 = db.prepare("SELECT COUNT(*) as cnt FROM writes WHERE thread_id = ? AND checkpoint_id = ?").get('t1', 'c2') as { cnt: number };
    const w3 = db.prepare("SELECT COUNT(*) as cnt FROM writes WHERE thread_id = ? AND checkpoint_id = ?").get('t1', 'c3') as { cnt: number };
    expect(w1.cnt).toBe(0);
    expect(w2.cnt).toBe(0);
    expect(w3.cnt).toBe(1);
    const wOther = db.prepare("SELECT COUNT(*) as cnt FROM writes WHERE thread_id = ?").get('t2') as { cnt: number };
    expect(wOther.cnt).toBe(1);

    db.close();
    store.close();
  });
});
