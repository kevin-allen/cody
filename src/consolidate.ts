import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import type { MemoryStore } from "./memory.js";

export type ConsolidationRecord = {
  kind: "failure" | "decision" | "milestone";
  cue: string;
  triggerText?: string;
  body: string;
  scope?: string;
  confidence?: number;
};

const INSTRUCTION =
  "You are a memory consolidator for a coding agent. Read the session transcript below and extract only durable, reusable lessons worth recalling in FUTURE sessions. Output ONLY a JSON array (no prose, no code fences). Each element must be an object: {\"kind\": one of \"failure\"|\"decision\"|\"milestone\", \"cue\": a short trigger phrase, \"triggerText\": keywords or an error signature to search on, \"body\": the lesson in <= 60 words, actionable, \"scope\": optional context tag, \"confidence\": 1}. RULES: (1) Emit [] for routine sessions with nothing durable to learn — most sessions should yield 0 or 1 records. (2) For a \"failure\" record, emit it ONLY if the transcript shows the failure was actually RESOLVED — a fix was applied and the same operation then succeeded. Never record a failure whose fix was not confirmed to work. (3) Never include secrets, tokens, API keys, or large file contents. (4) Prefer environment quirks, confirmed fixes, and decisions-with-rationale. TRANSCRIPT:\n";

export async function consolidate(model: BaseChatModel, transcript: string): Promise<ConsolidationRecord[]> {
  try {
    const message = new HumanMessage(INSTRUCTION + transcript);
    // call invoke as a method on the model
    const res = await (model as any).invoke([message]);
    const contentRaw = (res as { content?: unknown }).content;
    let contentStr = "";
    if (typeof contentRaw === "string") contentStr = contentRaw;
    else if (Array.isArray(contentRaw)) contentStr = contentRaw.map((p) => String(p)).join("\n");
    else if (contentRaw !== undefined && contentRaw !== null) contentStr = String(contentRaw);

    // extract first '[' to last ']' substring
    const first = contentStr.indexOf("[");
    const last = contentStr.lastIndexOf("]");
    if (first === -1 || last === -1 || last <= first) return [];
    const jsonSlice = contentStr.slice(first, last + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const validated: ConsolidationRecord[] = [];
    for (const el of parsed) {
      if (!el || typeof el !== "object") continue;
      const obj = el as Record<string, unknown>;
      const kind = obj.kind;
      if (kind !== "failure" && kind !== "decision" && kind !== "milestone") continue;
      const bodyRaw = obj.body;
      if (typeof bodyRaw !== "string") continue;
      const body = bodyRaw.trim();
      if (body.length === 0) continue;
      const cue = obj.cue !== undefined && obj.cue !== null ? String(obj.cue) : "";
      const triggerText = obj.triggerText !== undefined && obj.triggerText !== null ? String(obj.triggerText) : undefined;
      const scope = obj.scope !== undefined && obj.scope !== null ? String(obj.scope) : undefined;
      const confidence = typeof obj.confidence === "number" ? obj.confidence : 1;
      validated.push({ kind: kind as "failure" | "decision" | "milestone", cue, triggerText, body: body.slice(0, 600), scope, confidence });
    }

    return validated;
  } catch {
    return [];
  }
}

export type ProvisionalVerdict = { index: number; verdict: "confirmed" | "unconfirmed" | "wrong" };

const REVIEW_INSTRUCTION =
  "You are verifying provisional memory notes a coding agent recorded during a session. For EACH numbered note below, decide from the session transcript whether it is: \"confirmed\" (the session's outcome supports it — e.g. a claimed fix was actually followed by success, or a decision was actually made), \"unconfirmed\" (the transcript neither supports nor contradicts it), or \"wrong\" (the transcript contradicts it). Output ONLY a JSON array of objects {\"index\": <the note's number>, \"verdict\": \"confirmed\"|\"unconfirmed\"|\"wrong\"}. NOTES:\n";

export async function reviewProvisional(
  model: BaseChatModel,
  transcript: string,
  items: { index: number; body: string }[],
): Promise<ProvisionalVerdict[]> {
  if (items.length === 0) return [];
  try {
    const notes = items.map((i) => `${i.index}. ${i.body}`).join("\n");
    const message = new HumanMessage(REVIEW_INSTRUCTION + notes + "\n\nTRANSCRIPT:\n" + transcript);
    const res = await (model as any).invoke([message]);
    const contentRaw = (res as { content?: unknown }).content;
    let contentStr = "";
    if (typeof contentRaw === "string") contentStr = contentRaw;
    else if (Array.isArray(contentRaw)) contentStr = contentRaw.map((p) => String(p)).join("\n");
    else if (contentRaw !== undefined && contentRaw !== null) contentStr = String(contentRaw);

    const first = contentStr.indexOf("[");
    const last = contentStr.lastIndexOf("]");
    if (first === -1 || last === -1 || last <= first) return [];
    const jsonSlice = contentStr.slice(first, last + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const validated: ProvisionalVerdict[] = [];
    for (const el of parsed) {
      if (!el || typeof el !== "object") continue;
      const obj = el as Record<string, unknown>;
      const index = obj.index;
      if (typeof index !== "number" || !Number.isFinite(index)) continue;
      const verdict = obj.verdict;
      if (verdict !== "confirmed" && verdict !== "unconfirmed" && verdict !== "wrong") continue;
      validated.push({ index, verdict });
    }

    return validated;
  } catch {
    return [];
  }
}

/**
 * Review one session's PROVISIONAL memories against its transcript and apply
 * the verdicts (promote confirmed ones, prune the rest). Shared by the normal
 * end-of-session consolidation path (manual/auto /compact, clean REPL exit)
 * and the startup "orphan sweep" (see `findOrphanedSessions`) that recovers
 * provisional memories left behind by a session that was killed, crashed, or
 * restarted before it ever reached that boundary.
 *
 * `getTranscript` should resolve to `undefined` when the session has too
 * little history to review meaningfully, or its transcript can no longer be
 * recovered (e.g. checkpoints were pruned) — in that case the provisional
 * memories are left untouched so a later sweep can retry them.
 */
export async function reviewSessionProvisional(
  memory: MemoryStore,
  model: BaseChatModel,
  sessionId: string,
  getTranscript: (sessionId: string) => Promise<string | undefined>,
): Promise<{ promoted: number; pruned: number }> {
  const provisional = memory.listProvisional().filter((m) => m.sourceSession === sessionId);
  if (provisional.length === 0) return { promoted: 0, pruned: 0 };

  let transcript: string | undefined;
  try {
    transcript = await getTranscript(sessionId);
  } catch {
    transcript = undefined;
  }
  if (!transcript) return { promoted: 0, pruned: 0 };

  const verdicts = await reviewProvisional(
    model,
    transcript,
    provisional.map((m, i) => ({ index: i, body: m.body })),
  ).catch(() => []);

  let promoted = 0;
  let pruned = 0;
  for (const v of verdicts) {
    if (v.index < 0 || v.index >= provisional.length) continue;
    const target = provisional[v.index]!;
    try {
      if (v.verdict === "confirmed") {
        memory.promoteMemory(target.id);
        promoted += 1;
      } else {
        memory.pruneProvisional(target.id);
        pruned += 1;
      }
    } catch {
      // continue
    }
  }
  return { promoted, pruned };
}

/**
 * Distinct sourceSession ids among current PROVISIONAL memories that do not
 * belong to `currentSessionId` — i.e. left behind by some other (necessarily
 * prior, since a session id is fresh per REPL start unless resumed) session.
 * A memory with no sourceSession can't be attributed to any recoverable
 * transcript, so it is not considered an orphan here.
 */
export function findOrphanedSessions(memory: MemoryStore, currentSessionId: string | undefined): string[] {
  const ids = new Set<string>();
  for (const m of memory.listProvisional()) {
    if (m.sourceSession && m.sourceSession !== currentSessionId) ids.add(m.sourceSession);
  }
  return [...ids];
}

/**
 * Consolidate a transcript and review its provisional memories in one call.
 * Shared by the REPL end-of-session path and the headless run path.
 *
 * - Calls `consolidate(model, transcript)`, inserts each returned record (status
 *   "active", origin "consolidated", sourceSession = sessionId — matching the
 *   REPL's existing insert exactly).
 * - Then calls `reviewSessionProvisional` to promote confirmed / prune
 *   unconfirmed provisional memories from the same session.
 * - Returns the counts; never throws (best-effort, returns {0,0,0} on failure).
 */
export async function consolidateTranscript(
  memory: MemoryStore,
  model: BaseChatModel,
  sessionId: string,
  transcript: string,
): Promise<{ inserted: number; promoted: number; pruned: number }> {
  try {
    const records = await consolidate(model, transcript).catch(() => []);
    let inserted = 0;
    for (const r of records) {
      try {
        memory.insertMemory({
          kind: r.kind,
          cue: r.cue ?? "",
          triggerText: r.triggerText,
          body: r.body,
          scope: r.scope,
          confidence: r.confidence ?? 1,
          sourceSession: sessionId,
        });
        inserted += 1;
      } catch {
        // continue
      }
    }
    let promoted = 0;
    let pruned = 0;
    try {
      const result = await reviewSessionProvisional(memory, model, sessionId, async () => transcript);
      promoted = result.promoted;
      pruned = result.pruned;
    } catch {
      // swallow
    }
    return { inserted, promoted, pruned };
  } catch {
    return { inserted: 0, promoted: 0, pruned: 0 };
  }
}
