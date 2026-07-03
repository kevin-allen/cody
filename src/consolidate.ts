import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";

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
