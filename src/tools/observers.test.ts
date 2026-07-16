import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openMemoryStore, fingerprintError } from "../memory.js";
import {
  failureRecallObserver,
  commitMilestoneObserver,
  defaultObservers,
} from "./observers.js";
import type { ToolResultObserver } from "./observers.js";
import type { ToolContext, ApprovalRequest } from "./index.js";
import type { Config } from "../config.js";
import { gate } from "./index.js";

// Minimal fake config
const cfg: Config = {
  models: { default: { provider: "openai", model: "gpt-4o" } },
  roles: { agent: "default" },
  permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: [] } },
  limits: { recursionLimit: 10, compactThresholdTokens: 1000, evictThresholdTokens: 32768, keepRecentToolResults: 5, shellOutputMaxChars: 30000, fileReadMaxChars: 30000 },
  sessions: { enabled: true },
  trace: { enabled: false },
  mcp: { servers: {} },
};

// ---------------------------------------------------------------------------
// failureRecallObserver unit tests
// ---------------------------------------------------------------------------
describe("failureRecallObserver", () => {
  it("ignores a non-failure result (returns undefined, no events recorded)", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-nf-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "echo ok" };
    const out = failureRecallObserver.observe(ctx, req, "ok [exit 0]");
    expect(out).toBeUndefined();

    const db = new Database(join(wd, "m.db"));
    const feRows = db.prepare("SELECT * FROM failure_events").all();
    expect(feRows.length).toBe(0);
    const reRows = db.prepare("SELECT * FROM recall_events").all();
    expect(reRows.length).toBe(0);
    db.close();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("detects each failure shape: [error] ..., [timed out ..., ... [exit 2]", () => {
    const shapes = [
      "[error] something went wrong",
      "[timed out after 60s",
      "command failed [exit 2]",
    ];

    for (const shape of shapes) {
      const wd = mkdtempSync(join(tmpdir(), "cody-obs-shape-"));
      const store = openMemoryStore(join(wd, "m.db"));

      const ctx: ToolContext = {
        workdir: wd,
        config: cfg,
        confirm: async () => ({ approved: true }),
        memory: store,
        sessionId: "S",
      };

      const req: ApprovalRequest = { action: "shell", title: "Run", preview: "cmd" };
      const out = failureRecallObserver.observe(ctx, req, shape);
      // No matching memory, so returns undefined — but a failure event is still recorded
      expect(out).toBeUndefined();

      const db = new Database(join(wd, "m.db"));
      const feRows = db.prepare("SELECT * FROM failure_events").all() as any[];
      expect(feRows.length).toBeGreaterThanOrEqual(1);
      db.close();

      store.close();
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("returns result with [memory #id] when a stored failure memory matches, and records recall + failure events", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-match-"));
    const store = openMemoryStore(join(wd, "m.db"));
    const fakeError = "[error] pnpm add timed out behind proxy";
    const fp = fingerprintError(fakeError);
    const id = store.insertMemory({
      kind: "failure",
      cue: fp,
      triggerText: "pnpm add timed out behind proxy",
      body: "use --offline or configure proxy",
    });

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "sess-1",
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "pnpm add", preapproved: true };
    const out = failureRecallObserver.observe(ctx, req, fakeError);
    expect(typeof out).toBe("string");
    expect(out!.includes("[memory #")).toBe(true);
    expect(out!.includes("use --offline or configure proxy")).toBe(true);

    // verify recall_event and failure_event were recorded
    const db = new Database(join(wd, "m.db"));
    const reRows = db.prepare("SELECT * FROM recall_events").all() as any[];
    expect(reRows.length).toBeGreaterThanOrEqual(1);
    const feRows = db.prepare("SELECT * FROM failure_events").all() as any[];
    expect(feRows.length).toBeGreaterThanOrEqual(1);
    // failure event should have injected_memory_id set
    const fe = feRows.find((r: any) => r.injected_memory_id === id);
    expect(fe).toBeDefined();
    db.close();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("returns undefined but records failure event when no matching memory found", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-nomatch-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "cmd" };
    const out = failureRecallObserver.observe(ctx, req, "[error] totally unknown failure");
    expect(out).toBeUndefined();

    // failure event still recorded
    const db = new Database(join(wd, "m.db"));
    const feRows = db.prepare("SELECT * FROM failure_events").all() as any[];
    expect(feRows.length).toBe(1);
    expect(feRows[0].injected_memory_id).toBeNull();
    db.close();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("reconsolidation: prior injection this session decrements confidence", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-recon-"));
    const store = openMemoryStore(join(wd, "m.db"));
    const fakeError = "[error] boom";
    const fp = fingerprintError(fakeError);
    const id = store.insertMemory({
      kind: "failure",
      cue: fp,
      triggerText: "boom",
      body: "fix: do X",
    });

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "sess-2",
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "cmd" };

    // First failure: injects and records
    const out1 = failureRecallObserver.observe(ctx, req, fakeError);
    expect(typeof out1).toBe("string");
    expect(out1!.includes("[memory #")).toBe(true);

    const afterFirst = store.listMemories().find((m) => m.id === id)!.confidence;

    // Second failure in same session: decrements confidence, then confidence=0 so
    // recallByFingerprint filters it out — observer returns undefined.
    const out2 = failureRecallObserver.observe(ctx, req, fakeError);
    expect(out2).toBeUndefined();

    const afterSecond = store.listMemories().find((m) => m.id === id)!.confidence;
    expect(afterSecond).toBeLessThan(afterFirst);

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// commitMilestoneObserver unit tests
// ---------------------------------------------------------------------------
describe("commitMilestoneObserver", () => {
  it("inserts a provisional origin=event milestone on successful git commit", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-cm-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = {
      action: "shell",
      title: "Run",
      preview: 'git commit -m "memory: add feature (FR-99)"',
    };

    const out = commitMilestoneObserver.observe(
      ctx,
      req,
      "[main abc1234] memory: add feature (FR-99)\n 2 files changed\n[exit 0]",
    );
    expect(out).toBeUndefined(); // never modifies result

    const provisional = store.listProvisional();
    const hit = provisional.find(
      (m) => m.kind === "milestone" && m.origin === "event" && m.body.includes("memory: add feature (FR-99)"),
    );
    expect(hit).toBeDefined();
    expect(hit!.status).toBe("provisional");
    expect(hit!.origin).toBe("event");
    expect(hit!.sourceSession).toBe("S");

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("parses single-quoted -m subjects", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-cm-sq-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = {
      action: "shell",
      title: "Run",
      preview: "git commit -m 'single-quoted subject'",
    };

    commitMilestoneObserver.observe(ctx, req, "[main def5678] single-quoted subject\n[exit 0]");

    const provisional = store.listProvisional();
    const hit = provisional.find(
      (m) => m.kind === "milestone" && m.body.includes("single-quoted subject"),
    );
    expect(hit).toBeDefined();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("does not insert on nonzero exit", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-cm-fail-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = {
      action: "shell",
      title: "Run",
      preview: 'git commit -m "broken commit"',
    };

    commitMilestoneObserver.observe(ctx, req, "error: nothing to commit\n[exit 1]");

    const provisional = store.listProvisional();
    const hit = provisional.find((m) => m.kind === "milestone" && m.origin === "event");
    expect(hit).toBeUndefined();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("does not insert for non-commit shell commands", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-cm-non-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const req: ApprovalRequest = {
      action: "shell",
      title: "Run",
      preview: "git push origin main",
    };

    commitMilestoneObserver.observe(ctx, req, "Everything up-to-date\n[exit 0]");

    const provisional = store.listProvisional();
    const hit = provisional.find((m) => m.kind === "milestone" && m.origin === "event");
    expect(hit).toBeUndefined();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// gate() dispatch integration tests
// ---------------------------------------------------------------------------
describe("gate observer dispatch", () => {
  it("observer that throws does not break the tool result", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-throw-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const throwingObserver: ToolResultObserver = {
      name: "thrower",
      observe() {
        throw new Error("boom");
      },
    };

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
      observers: [throwingObserver],
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "echo ok", preapproved: true };
    const out = await gate(ctx, req, () => "ok [exit 0]");
    expect(out).toBe("ok [exit 0]");

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("observer that returns a string replaces the result", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-replace-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const replacingObserver: ToolResultObserver = {
      name: "replacer",
      observe(_ctx, _req, _result) {
        return "replaced!";
      },
    };

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
      observers: [replacingObserver],
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "echo ok", preapproved: true };
    const out = await gate(ctx, req, () => "original");
    expect(out).toBe("replaced!");

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("ctx.observers overrides defaults", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-override-"));
    const store = openMemoryStore(join(wd, "m.db"));

    // Insert a failure memory so default failureRecallObserver would normally match
    const fakeError = "[error] something";
    const fp = fingerprintError(fakeError);
    store.insertMemory({
      kind: "failure",
      cue: fp,
      triggerText: "something",
      body: "a memory",
    });

    const noopObserver: ToolResultObserver = {
      name: "noop",
      observe() {
        return undefined;
      },
    };

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
      observers: [noopObserver],
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "cmd", preapproved: true };
    const out = await gate(ctx, req, () => fakeError);
    // With custom noop observer, no failure injection should happen
    expect(out).toBe(fakeError);

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("observers do NOT run for a denied result", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-obs-denied-"));
    const store = openMemoryStore(join(wd, "m.db"));

    let observerRan = false;
    const spyObserver: ToolResultObserver = {
      name: "spy",
      observe() {
        observerRan = true;
        return undefined;
      },
    };

    const ctx: ToolContext = {
      workdir: wd,
      config: { ...cfg, permissions: { ...cfg.permissions, mode: "readonly" } },
      confirm: async () => ({ approved: false, reason: "no" }),
      memory: store,
      sessionId: "S",
      observers: [spyObserver],
    };

    const req: ApprovalRequest = { action: "shell", title: "Run", preview: "rm -rf /" };
    const out = await gate(ctx, req, () => "should not run");

    // In restricted mode, shell is denied by policy
    expect(out).toContain("[denied]");
    expect(observerRan).toBe(false);

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});
