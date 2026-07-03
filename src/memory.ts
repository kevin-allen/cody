import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

export interface FailureEvent {
  ts: string;
  sessionId?: string;
  fingerprint: string;
  errorText: string;
  injectedMemoryId?: number;
}

export interface RecallEvent {
  ts: string;
  sessionId?: string;
  cueKind: string;
  cueText: string;
  matchedIds: number[];
  injectedIds: number[];
}

export interface MemoryStore {
  recordFailureEvent(e: FailureEvent): void;
  recordRecallEvent(e: RecallEvent): void;
  topFingerprints(limit: number): { fingerprint: string; count: number; sampleText: string }[];
  failureCount(): number;
  distinctFingerprintCount(): number;
  close(): void;
}

export function openMemoryStore(dbPath: string): MemoryStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // enable WAL
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // ignore
  }

  db.prepare(
    `CREATE TABLE IF NOT EXISTS failure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      session_id TEXT,
      fingerprint TEXT,
      error_text TEXT,
      injected_memory_id INTEGER
    )`,
  ).run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS recall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      session_id TEXT,
      cue_kind TEXT,
      cue_text TEXT,
      matched_ids TEXT,
      injected_ids TEXT
    )`,
  ).run();

  const insFailure = db.prepare(
    "INSERT INTO failure_events(ts, session_id, fingerprint, error_text, injected_memory_id) VALUES (?, ?, ?, ?, ?)",
  );
  const insRecall = db.prepare(
    "INSERT INTO recall_events(ts, session_id, cue_kind, cue_text, matched_ids, injected_ids) VALUES (?, ?, ?, ?, ?, ?)",
  );

  return {
    recordFailureEvent: (e: FailureEvent) => {
      insFailure.run(e.ts, e.sessionId ?? null, e.fingerprint, e.errorText, e.injectedMemoryId ?? null);
    },
    recordRecallEvent: (e: RecallEvent) => {
      insRecall.run(e.ts, e.sessionId ?? null, e.cueKind, e.cueText, JSON.stringify(e.matchedIds), JSON.stringify(e.injectedIds));
    },
    topFingerprints: (limit: number) => {
      const rows = db
        .prepare(
          `SELECT fingerprint, COUNT(*) AS cnt, MIN(error_text) AS sampleText FROM failure_events GROUP BY fingerprint ORDER BY cnt DESC LIMIT ?`,
        )
        .all(limit) as { fingerprint: string; cnt: number; sampleText: string }[];
      return rows.map((r) => ({ fingerprint: r.fingerprint, count: r.cnt, sampleText: r.sampleText ?? "" }));
    },
    failureCount: () => {
      const row = db.prepare("SELECT COUNT(*) AS c FROM failure_events").get() as { c: number };
      return row.c ?? 0;
    },
    distinctFingerprintCount: () => {
      const row = db.prepare("SELECT COUNT(DISTINCT fingerprint) AS c FROM failure_events").get() as { c: number };
      return row.c ?? 0;
    },
    close: () => db.close(),
  };
}

// Pure function: normalize an error string and return short stable hex digest
export function fingerprintError(text: string): string {
  if (!text) return "";
  let s = String(text);
  // keep original for token extraction
  const orig = s;

  // extract error/exception type token if present
  const errMatch = s.match(/\b([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception))\b/);
  const errToken = errMatch && errMatch[1] ? errMatch[1].toLowerCase() : "";

  // extract first command-like token (word with letters/numbers/._-/) after possible "failed to" phrases or after "command" or at start
  let cmdToken = "";
  const cmdAfter = s.match(/(?:failed to run|failed to execute|failed:|command not found:|sh:\s|bash:\s)(?:\s*"?)?([a-zA-Z0-9._-]+)/i);
  if (cmdAfter && cmdAfter[1]) cmdToken = cmdAfter[1].toLowerCase();
  if (!cmdToken) {
    const firstWord = s.trim().match(/^([a-zA-Z0-9._-]+)/);
    if (firstWord && firstWord[1]) {
      const w = firstWord[1];
      // avoid capturing generic 'error' token
      if (!/^error$/i.test(w)) cmdToken = w.toLowerCase();
    }
  }

  // Normalize: lowercase
  s = s.toLowerCase();

  // Note: normalize filesystem paths (unix, relative, windows, /tmp) to a single placeholder

  // remove ISO-8601 timestamps
  s = s.replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, " <ts> ");

  // remove UUIDs
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " <uuid> ");

  // remove hex addresses
  s = s.replace(/0x[0-9a-f]+/g, " <hex> ");

  // remove line:column patterns like :123:45 or :123
  s = s.replace(/:\d+(?::\d+)?/g, ":<line>");

  // remove windows paths like C:\path\to\file
  s = s.replace(/[a-zA-Z]:\\[\w\\/.\-]*/g, " <path> ");

  // remove unix/relative paths containing slashes
  s = s.replace(/(?:\.\.|\.|\/~)?(\/?[\w@%_\-./~]+\/[\w@%_\-./~]+)+/g, " <path> ");

  // collapse repeated slashes
  s = s.replace(/\/{2,}/g, "/");

  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  // assemble canonical string: include errToken and cmdToken and the normalized message
  const canonical = `${errToken}|${cmdToken}|${s}`;

  const h = createHash("sha1").update(canonical).digest("hex");
  return h.slice(0, 12);
}
