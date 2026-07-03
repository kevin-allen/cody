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

export type MemoryRow = {
  id: number;
  kind: string;
  cue: string;
  triggerText: string;
  body: string;
  scope?: string | null;
  confidence: number;
  uses: number;
  lastUsed?: string | null;
  created: string;
  sourceSession?: string | null;
};

export interface MemoryStore {
  recordFailureEvent(e: FailureEvent): void;
  recordRecallEvent(e: RecallEvent): void;
  topFingerprints(limit: number): { fingerprint: string; count: number; sampleText: string }[];
  failureCount(): number;
  distinctFingerprintCount(): number;
  close(): void;

  // new store-layer API for consolidated memories
  insertMemory(m: { kind: string; cue: string; triggerText?: string; body: string; scope?: string; confidence?: number; sourceSession?: string }): number;
  recallByFingerprint(fingerprint: string): MemoryRow | undefined;
  recallByText(text: string, kind?: string, limit?: number): MemoryRow[];
  bumpConfidence(id: number, delta?: number): void;
  decrementConfidence(id: number, delta?: number): void;
  touchUsed(id: number, ts: string): void;
  listMemories(): MemoryRow[];
  forget(id: number): void;
  priorInjectionThisSession(sessionId: string | undefined, fingerprint: string): number | undefined;
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

  const selPriorWithSession = db.prepare(
    `SELECT injected_memory_id FROM failure_events WHERE fingerprint = ? AND injected_memory_id IS NOT NULL AND session_id = ? ORDER BY id DESC LIMIT 1`,
  );
  const selPriorNoSession = db.prepare(
    `SELECT injected_memory_id FROM failure_events WHERE fingerprint = ? AND injected_memory_id IS NOT NULL AND session_id IS NULL ORDER BY id DESC LIMIT 1`,
  );

  // Create consolidated memories table
  db.prepare(
    `CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,
      cue TEXT,
      trigger_text TEXT,
      body TEXT,
      scope TEXT,
      confidence INTEGER DEFAULT 1,
      uses INTEGER DEFAULT 0,
      last_used TEXT,
      created TEXT,
      source_session TEXT
    )`,
  ).run();

  // Create an FTS5 table for full-text search over trigger_text and body.
  // We'll maintain this manually in the insert/update/delete methods by writing to the FTS table with the same rowid.
  try {
    db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(trigger_text, body)`).run();
  } catch {
    // ignore if FTS5 not available; searches will still work by simple LIKE fallback
  }

  const insMem = db.prepare(
    `INSERT INTO memories(kind, cue, trigger_text, body, scope, confidence, uses, last_used, created, source_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selMemByKindCue = db.prepare(`SELECT * FROM memories WHERE kind = ? AND cue = ? LIMIT 1`);
  const selMemById = db.prepare(`SELECT * FROM memories WHERE id = ?`);
  const updConfidence = db.prepare(`UPDATE memories SET confidence = confidence + ? WHERE id = ?`);
  const decConfidence = db.prepare(`UPDATE memories SET confidence = confidence - ? WHERE id = ?`);
  const touchStmt = db.prepare(`UPDATE memories SET uses = uses + 1, last_used = ? WHERE id = ?`);
  const listAll = db.prepare(`SELECT * FROM memories`);
  const delMem = db.prepare(`DELETE FROM memories WHERE id = ?`);

  const insFts = db.prepare(`INSERT INTO memories_fts(rowid, trigger_text, body) VALUES (?, ?, ?)`);
  const updFts = db.prepare(`INSERT INTO memories_fts(rowid, trigger_text, body) VALUES (?, ?, ?)`);
  const delFts = db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`);

  const transactionInsertMemory = db.transaction((m: {
    kind: string;
    cue: string;
    triggerText?: string;
    body: string;
    scope?: string;
    confidence?: number;
    sourceSession?: string;
  }) => {
    // dedupe-on-write
    const existing = selMemByKindCue.get(m.kind, m.cue) as any;
    if (existing && existing.id) {
      updConfidence.run(1, existing.id);
      return existing.id as number;
    }

    const created = new Date().toISOString();
    const body = (m.body ?? "").slice(0, 600);
    const trigger = (m.triggerText ?? m.cue ?? "").slice(0, 1000);
    const confidence = m.confidence ?? 1;
    const info = insMem.run(m.kind, m.cue, trigger, body, m.scope ?? null, confidence, 0, null, created, m.sourceSession ?? null);
    const id = info.lastInsertRowid as number;
    // write into FTS (if exists)
    try {
      insFts.run(id, trigger, body);
    } catch {
      // ignore if FTS5 not available
    }
    return id;
  });

  const transactionForget = db.transaction((id: number) => {
    delFts.run(id);
    delMem.run(id);
  });

  const transactionBump = db.transaction((id: number, delta: number) => {
    updConfidence.run(delta, id);
  });

  const transactionDec = db.transaction((id: number, delta: number) => {
    decConfidence.run(delta, id);
  });

  const transactionTouch = db.transaction((id: number, ts: string) => {
    touchStmt.run(ts, id);
  });

  function recallByFingerprintImpl(fingerprint: string) {
    const row = db
      .prepare(
        `SELECT * FROM memories WHERE kind = 'failure' AND cue = ? AND confidence > 0 ORDER BY (last_used IS NOT NULL) DESC, last_used DESC, confidence DESC, id DESC LIMIT 1`,
      )
      .get(fingerprint) as any;
    if (!row) return undefined;
    return mapRowToMemoryRow(row);
  }

  function sanitizeFtsQuery(q: string) {
    if (!q) return "";
    // remove double quotes and some special characters
    return q.replace(/["'()*:+\-]/g, " ").trim();
  }

  function recallByTextImpl(text: string, kind?: string, limit = 3) {
    const q = sanitizeFtsQuery(text);
    if (!q) return [];
    // prefer FTS match; fallback to LIKE only if FTS is unavailable (throws)
    let rows: any[] = [];
    try {
      const words = q.split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      // Use OR semantics so any query token can match; ranking by bm25 brings best matches first
      const matchQ = words.map((w) => `${w}`).join(" OR ");
      if (kind) {
        // reference the FTS table by name (memories_fts) — MATCH does not accept table aliases
        rows = db
          .prepare(
            `SELECT m.* FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id WHERE m.confidence > 0 AND m.kind = ? AND memories_fts MATCH ? ORDER BY bm25(memories_fts), m.confidence DESC, (m.last_used IS NOT NULL) DESC, m.last_used DESC, m.id DESC LIMIT ?`,
          )
          .all(kind, matchQ, limit);
      } else {
        rows = db
          .prepare(
            `SELECT m.* FROM memories m JOIN memories_fts ON memories_fts.rowid = m.id WHERE m.confidence > 0 AND memories_fts MATCH ? ORDER BY bm25(memories_fts), m.confidence DESC, (m.last_used IS NOT NULL) DESC, m.last_used DESC, m.id DESC LIMIT ?`,
          )
          .all(matchQ, limit);
      }
    } catch (e) {
      // FTS not available -> fall back to LIKE (word-wise OR) search
      const words = q.split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const likeClauses = words.map(() => `(trigger_text LIKE ? OR body LIKE ? )`).join(" OR ");
      const params: any[] = [];
      for (const w of words) {
        const like = `%${w}%`;
        params.push(like, like);
      }
      let sql: string;
      if (kind) {
        sql = `SELECT * FROM memories WHERE confidence > 0 AND kind = ? AND (${likeClauses}) ORDER BY confidence DESC, (last_used IS NOT NULL) DESC, last_used DESC, id DESC LIMIT ?`;
        params.unshift(kind);
      } else {
        sql = `SELECT * FROM memories WHERE confidence > 0 AND (${likeClauses}) ORDER BY confidence DESC, (last_used IS NOT NULL) DESC, last_used DESC, id DESC LIMIT ?`;
      }
      params.push(limit);
      rows = db.prepare(sql).all(...params);
    }

    return rows.map(mapRowToMemoryRow);
  }

  function mapRowToMemoryRow(row: any): MemoryRow {
    return {
      id: row.id,
      kind: row.kind,
      cue: row.cue,
      triggerText: row.trigger_text ?? row.triggerText ?? "",
      body: row.body ?? "",
      scope: row.scope ?? null,
      confidence: row.confidence ?? 0,
      uses: row.uses ?? 0,
      lastUsed: row.last_used ?? null,
      created: row.created ?? "",
      sourceSession: row.source_session ?? null,
    };
  }

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

    // store-layer API
    insertMemory: (m) => transactionInsertMemory(m),
    recallByFingerprint: (fp) => recallByFingerprintImpl(fp),
    recallByText: (text, kind, limit) => recallByTextImpl(text, kind, limit),
    bumpConfidence: (id, delta = 1) => transactionBump(id, delta),
    decrementConfidence: (id, delta = 1) => transactionDec(id, delta),
    touchUsed: (id, ts) => transactionTouch(id, ts),
    listMemories: () => listAll.all().map(mapRowToMemoryRow),
    forget: (id) => transactionForget(id),
    priorInjectionThisSession: (sessionId: string | undefined, fingerprint: string) => {
      try {
        const row = sessionId ? selPriorWithSession.get(fingerprint, sessionId) : selPriorNoSession.get(fingerprint);
        if (!row) return undefined;
        const val = (row as any).injected_memory_id;
        return typeof val === "number" ? val : undefined;
      } catch {
        return undefined;
      }
    },
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
