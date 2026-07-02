import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
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

export function openSessionStore(dbPath: string): SessionStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // our index table
  db.prepare(
    `CREATE TABLE IF NOT EXISTS cody_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      preview TEXT DEFAULT '' ,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0
    )`,
  ).run();

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
        .prepare("SELECT id, created_at AS createdAt, updated_at AS updatedAt, preview, input_tokens AS inputTokens, output_tokens AS outputTokens FROM cody_sessions ORDER BY updated_at DESC, rowid DESC")
        .all() as {
          id: string;
          createdAt: string;
          updatedAt: string;
          preview: string;
          inputTokens: number;
          outputTokens: number;
        }[];
      return rows as SessionMeta[];
    },
    latest: (): string | undefined => {
      const row = db
        .prepare("SELECT id FROM cody_sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get() as { id: string } | undefined;
      return row ? row.id : undefined;
    },
    has: (id: string): boolean => {
      const row = db.prepare("SELECT 1 FROM cody_sessions WHERE id = ?").get(id);
      return !!row;
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
