import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult, Generation } from "@langchain/core/outputs";

// ChatGeneration extends Generation with a `message` field.
interface ChatGen extends Generation {
  message?: BaseMessage;
}

function fmtDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function serializeMessage(m: BaseMessage): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    role: typeof m._getType === "function" ? m._getType() : "unknown",
    content: (m as { content?: unknown }).content,
  };
  const tc = (m as { tool_calls?: unknown }).tool_calls;
  if (tc !== undefined) rec.tool_calls = tc;
  const id = (m as { id?: string }).id;
  if (id) rec.id = id;
  return rec;
}

export interface TraceHandle {
  readonly handler: BaseCallbackHandler;
  setSession(id: string | undefined): void;
  event(kind: string, data: Record<string, unknown>): void;
  readonly path: string;
  close(): void;
}

export function openTrace(dir: string): TraceHandle {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // dir creation is best-effort
  }

  const now = new Date();
  const filename = `${fmtDate(now)}-${process.pid}.jsonl.gz`;
  let filePath = join(dir, filename);

  // Reserve the filename (wx) so two concurrent trace writers don't collide.
  // We'll write the real content at close time.
  let reserveFd: number | undefined;
  try {
    reserveFd = openSync(filePath, "wx");
  } catch {
    const base = filename.replace(/\.jsonl\.gz$/, "");
    let suffix = 1;
    let ok = false;
    while (suffix <= 100) {
      const altPath = join(dir, `${base}-${suffix}.jsonl.gz`);
      try {
        reserveFd = openSync(altPath, "wx");
        filePath = altPath;
        ok = true;
        break;
      } catch {
        suffix++;
      }
    }
    if (!ok) {
      filePath = join(dir, `${base}-${Date.now()}.jsonl.gz`);
    }
  }
  // Release the reservation fd; we overwrite at close.
  if (reserveFd !== undefined) {
    try { closeSync(reserveFd); } catch { /* ignore */ }
  }

  let closed = false;
  let sessionId: string | undefined;
  let dirty = false;
  const parts: string[] = [];

  function writeLine(obj: Record<string, unknown>): void {
    if (closed) return;
    try {
      parts.push(JSON.stringify({ ...obj, sessionId }) + "\n");
      dirty = true;
    } catch {
      // never throw
    }
  }

  function flushToDiskSync(): void {
    if (!dirty) return;
    try {
      writeFileSync(filePath, gzipSync(Buffer.from(parts.join(""), "utf8")));
    } catch {
      // never throw
    }
  }

  const handler = new (class extends BaseCallbackHandler {
    name = "cody-trace";

    override async handleChatModelStart(
      _llm: Serialized,
      messages: BaseMessage[][],
      runId: string,
      parentRunId?: string,
      _extraParams?: Record<string, unknown>,
      tags?: string[],
    ): Promise<void> {
      writeLine({
        ts: new Date().toISOString(),
        kind: "call",
        runId,
        parentRunId,
        tags,
        messages: messages.map((group) => group.map(serializeMessage)),
      });
    }

    override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
      const gens = output.generations;
      let text: string | undefined;
      let usage_metadata: unknown;
      if (gens.length > 0 && gens[0]!.length > 0) {
        const gen = gens[0]![0]! as ChatGen;
        text = gen.text;
        usage_metadata = gen.message ? (gen.message as { usage_metadata?: unknown }).usage_metadata : undefined;
      }
      writeLine({
        ts: new Date().toISOString(),
        kind: "result",
        runId,
        text,
        usage_metadata,
      });
    }
  })();

  return {
    handler,
    setSession(id: string | undefined) { sessionId = id; },
    event(kind: string, data: Record<string, unknown>) {
      writeLine({ ts: new Date().toISOString(), kind, ...data });
    },
    path: filePath,
    close() {
      if (closed) return;
      closed = true;
      try { flushToDiskSync(); } catch { /* swallow */ }
    },
  };
}
