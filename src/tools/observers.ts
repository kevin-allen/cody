import type { ToolContext, ApprovalRequest } from "./index.js";
import { fingerprintError } from "../memory.js";

export interface ToolResultObserver {
  readonly name: string;
  /**
   * Inspect a completed tool result. Return a string to REPLACE the result
   * (e.g. to append an injected memory); return undefined to leave it alone.
   * Runs only after the tool executed — never for denied/blocked results that
   * short-circuited before execution. Throwing is safe: gate() swallows
   * observer errors so an observer can never break a tool.
   */
  observe(ctx: ToolContext, req: ApprovalRequest, result: string): string | undefined;
}

export const failureRecallObserver: ToolResultObserver = {
  name: "failure-recall",
  observe(ctx, _req, result) {
    // Detect genuine failures: starts with "[error]", starts with "[timed out",
    // or contains an exit marker with nonzero code like "[exit 1]".
    const isFailure =
      result.startsWith("[error]") || result.startsWith("[timed out") || /\[exit ([1-9][0-9]*)\]/.test(result);
    if (!isFailure || !ctx.memory) return undefined;

    const fp = fingerprintError(result);

    // reconsolidation & recall + injection
    try {
      // 1. reconsolidation: if we injected earlier in this session, decrement confidence
      const prior = ctx.memory.priorInjectionThisSession(ctx.sessionId, fp);
      if (typeof prior === "number") {
        try {
          ctx.memory.decrementConfidence(prior);
        } catch {
          // swallow
        }
      }

      // 2. recall by fingerprint, then by text fallback
      let hit = ctx.memory.recallByFingerprint(fp, ctx.sessionId);
      if (!hit) {
        const byText = ctx.memory.recallByText(result, "failure", 1, ctx.sessionId);
        if (byText && byText.length > 0) hit = byText[0];
      }

      // 3. if hit, augment finalOut and record recall event and touchUsed
      if (hit) {
        try {
          ctx.memory.touchUsed(hit.id, new Date().toISOString());
        } catch {
          // swallow
        }
        try {
          ctx.memory.recordRecallEvent({
            ts: new Date().toISOString(),
            sessionId: ctx.sessionId,
            cueKind: "failure",
            cueText: fp,
            matchedIds: [hit.id],
            injectedIds: [hit.id],
          });
        } catch {
          // swallow
        }
      }

      // finally, record the failure event with the injected_memory_id (if any)
      try {
        ctx.memory.recordFailureEvent({
          ts: new Date().toISOString(),
          sessionId: ctx.sessionId,
          fingerprint: fp,
          errorText: result.slice(0, 2000),
          injectedMemoryId: hit ? hit.id : undefined,
        });
      } catch {
        // swallow
      }

      // return augmented result when a memory was injected
      if (hit) {
        return `${result}\n[memory #${hit.id}] ${hit.body}`;
      }
    } catch {
      // swallow any errors during reconsolidation/recall
    }

    return undefined;
  },
};

export const commitMilestoneObserver: ToolResultObserver = {
  name: "commit-milestone",
  observe(ctx, req, result) {
    if (!ctx.memory) return undefined;

    const isGitCommit = req.action === "shell" && /^\s*git\s+commit\b/.test(req.preview);
    const isSuccess = result.includes("[exit 0]");
    if (isGitCommit && isSuccess) {
      try {
        const m = req.preview.match(/-m\s+(?:"([^"]*)"|'([^']*)')/);
        const subject = (m && (m[1] ?? m[2])) || "changes";
        try {
          ctx.memory.insertMemory({
            kind: "milestone",
            cue: `commit: ${subject.slice(0, 60)}`,
            triggerText: subject,
            body: `Committed: ${subject}`,
            status: "provisional",
            origin: "event",
            confidence: 1,
            sourceSession: ctx.sessionId,
          });
        } catch {
          // swallow
        }
      } catch {
        // swallow any errors during milestone detection/recording
      }
    }

    return undefined;
  },
};

export const defaultObservers: readonly ToolResultObserver[] = [
  failureRecallObserver,
  commitMilestoneObserver,
];
