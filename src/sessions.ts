import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import type { RunResult } from "better-sqlite3";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  title: string;
  inputTokens: number;
  outputTokens: number;
}

export type SessionRefResult = { ok: true; id: string } | { ok: false; message: string };

import type { BaseCheckpointSaver } from "@langchain/langgraph";

export interface SessionStore {
  readonly saver: BaseCheckpointSaver;
  newSessionId(): string;
  register(id: string): void;
  touch(id: string, preview: string | null, usage: { inputTokens: number; outputTokens: number }): void;
  list(): SessionMeta[];
  latest(): string | undefined;
  has(id: string): boolean;
  setTitle(id: string, title: string): void;
  pruneCheckpoints(id: string): number;
  close(): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const d = new Date();
  function pad(n: number, width = 2) {
    return String(n).padStart(width, "0");
  }
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return `s-${y}${m}${day}-${hh}${mm}${ss}${rand}`;
}

function collapsePreview(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function sanitizeTitle(raw: string): string {
  // collapse whitespace/newlines to single spaces
  let s = raw.replace(/\s+/g, " ");
  s = s.trim();
  // strip surrounding matching quotes
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  // cap to 60 chars
  if (s.length > 60) s = s.slice(0, 60);
  return s;
}

export function openSessionStore(dbPath: string): SessionStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // our index table (include title for new DBs)
  db.prepare(
    `CREATE TABLE IF NOT EXISTS cody_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      preview TEXT DEFAULT '' ,
      title TEXT DEFAULT '' ,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0
    )`,
  ).run();

  // Migration: ensure title column exists (older DBs may lack it)
  const info = db.prepare("PRAGMA table_info(cody_sessions)").all() as { name: string }[];
  const hasTitle = info.some((r) => r.name === "title");
  if (!hasTitle) {
    // empty string literal default
    db.prepare("ALTER TABLE cody_sessions ADD COLUMN title TEXT DEFAULT ''").run();
  }

  const saver = new SqliteSaver(db);

  return {
    saver,
    newSessionId: () => makeId(),
    register: (id: string) => {
      const now = nowIso();
      db.prepare(
        "INSERT OR REPLACE INTO cody_sessions(id, created_at, updated_at, preview, input_tokens, output_tokens) VALUES (?, ?, ?, ?, 0, 0)",
      ).run(id, now, now, "");
    },
    touch: (id: string, preview: string | null, usage: { inputTokens: number; outputTokens: number }) => {
      const now = nowIso();
      // ensure row exists
      const row = db
        .prepare("SELECT preview, input_tokens, output_tokens FROM cody_sessions WHERE id = ?")
        .get(id) as { preview?: string; input_tokens?: number; output_tokens?: number } | undefined;
      if (!row) return; // unknown id: noop
      const currentPreview: string = row.preview ?? "";
      const input = (row.input_tokens ?? 0) + (usage.inputTokens ?? 0);
      const output = (row.output_tokens ?? 0) + (usage.outputTokens ?? 0);
      const newPreview = currentPreview.length > 0 ? currentPreview : preview ? collapsePreview(preview) : "";
      db.prepare(
        "UPDATE cody_sessions SET preview = ?, updated_at = ?, input_tokens = ?, output_tokens = ? WHERE id = ?",
      ).run(newPreview, now, input, output, id);
    },
    list: (): SessionMeta[] => {
      const rows = db
        .prepare("SELECT id, created_at AS createdAt, updated_at AS updatedAt, preview, title, input_tokens AS inputTokens, output_tokens AS outputTokens FROM cody_sessions ORDER BY updated_at DESC, rowid DESC")
        .all() as {
          id: string;
          createdAt: string;
          updatedAt: string;
          preview: string;
          title: string;
          inputTokens: number;
          outputTokens: number;
        }[];
      return rows as SessionMeta[];
    },
    latest: (): string | undefined => {
      const row = db
        .prepare("SELECT id, title FROM cody_sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get() as { id: string; title?: string } | undefined;
      return row ? row.id : undefined;
    },
    has: (id: string): boolean => {
      const row = db.prepare("SELECT 1 FROM cody_sessions WHERE id = ?").get(id);
      return !!row;
    },
    setTitle: (id: string, title: string) => {
      const now = nowIso();
      const row = db.prepare("SELECT 1 FROM cody_sessions WHERE id = ?").get(id);
      if (!row) return; // unknown id: noop
      const s = sanitizeTitle(title);
      db.prepare("UPDATE cody_sessions SET title = ?, updated_at = ? WHERE id = ?").run(s, now, id);
    },
    pruneCheckpoints: (id: string): number => {
      // check if checkpoints table exists
      const chk = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
        .get();
      if (!chk) return 0;
      // find the max checkpoint_id for the thread (lexicographic max)
      const maxRow = db
        .prepare("SELECT MAX(checkpoint_id) as maxid FROM checkpoints WHERE thread_id = ?")
        .get(id) as { maxid?: string } | undefined;
      const maxid = maxRow?.maxid;
      if (!maxid) return 0; // nothing to delete
      // find checkpoint ids to delete
      const rows = db
        .prepare("SELECT checkpoint_id FROM checkpoints WHERE thread_id = ? AND checkpoint_id <> ?")
        .all(id, maxid) as { checkpoint_id: string }[];
      if (!rows || rows.length === 0) return 0;
      const ids = rows.map((r) => r.checkpoint_id);
      const qMarks = ids.map(() => "?").join(",");
      // delete matching writes if writes table exists
      const hasWrites = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='writes'").get();
      if (hasWrites) {
        db.prepare(`DELETE FROM writes WHERE thread_id = ? AND checkpoint_id IN (${qMarks})`).run(id, ...ids);
      }
      // delete checkpoints
      const del = db.prepare(`DELETE FROM checkpoints WHERE thread_id = ? AND checkpoint_id IN (${qMarks})`).run(id, ...ids) as RunResult;
      const changed = del.changes ?? 0;
      return changed;
    },
    close: () => db.close(),
  };
}

/**
 * Resolve a session reference. If `ref` is a number string (e.g. "1"), it's
 * treated as a 1-based index into the sessions array (sessions are newest-first).
 * Otherwise we first try an exact id match, then substring matches.
 */
export function resolveSessionRef(ref: string, sessions: SessionMeta[]): SessionRefResult {
  if (/^[0-9]+$/.test(ref)) {
    const n = parseInt(ref, 10);
    if (n < 1 || n > sessions.length) {
      return { ok: false, message: `no session #${n} (have ${sessions.length})` };
    }
    const s = sessions[n - 1];
    if (!s) return { ok: false, message: `no session #${n} (have ${sessions.length})` };
    return { ok: true, id: s.id };
  }

  // exact id match
  const exact = sessions.find((s) => s.id === ref);
  if (exact !== undefined) return { ok: true, id: exact.id };

  // substring matches
  const matches = sessions.filter((s) => s.id.includes(ref)).map((s) => s.id);
  if (matches.length === 1) {
    const id = matches[0]!;
    return { ok: true, id };
  }
  if (matches.length > 1) return { ok: false, message: `ambiguous, matches: ${matches.join(", ")}` };
  return { ok: false, message: `no session matching ${ref}` };
}
