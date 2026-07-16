import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryStore } from "../memory.js";
import { createTools, TOOL_INFO } from "./index.js";
import type { ToolContext } from "./index.js";
import type { Config } from "../config.js";

// Minimal fake config
const cfg: Config = {
  models: { default: { provider: "openai", model: "gpt-4o" } },
  roles: { agent: "default" },
  permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: [] } },
  limits: { recursionLimit: 10, compactThresholdTokens: 1000, evictThresholdTokens: 32768, keepRecentToolResults: 5, shellOutputMaxChars: 30000 },
  sessions: { enabled: true },
  mcp: { servers: {} },
};

describe("remember tool", () => {
  it("writes a provisional, agent-origin memory scoped to the current session", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-remember-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const tools = createTools(ctx);
    const remember = tools.find((t) => t.name === "remember");
    expect(remember).toBeDefined();

    await remember!.invoke({ kind: "decision", body: "always pre-warm the cache" });

    const provisional = store.listProvisional();
    const hit = provisional.find((m) => m.body === "always pre-warm the cache");
    expect(hit).toBeDefined();
    expect(hit!.status).toBe("provisional");
    expect(hit!.origin).toBe("agent");
    expect(hit!.sourceSession).toBe("S");

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});

describe("gate milestone hook on successful git commit", () => {
  it("records a provisional milestone memory when a git commit succeeds", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-commit-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const { gate } = await import("./index.js");
    await gate(
      ctx,
      { action: "shell", title: "Run", preview: 'git commit -m "memory: add feature (FR-99)"' },
      () => "[main abc1234] memory: add feature (FR-99)\n 2 files changed\n[exit 0]",
    );

    const provisional = store.listProvisional();
    const hit = provisional.find(
      (m) => m.kind === "milestone" && m.origin === "event" && m.body.includes("memory: add feature (FR-99)"),
    );
    expect(hit).toBeDefined();
    expect(hit!.status).toBe("provisional");

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("does not record a milestone memory when the git commit fails", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-commit-fail-"));
    const store = openMemoryStore(join(wd, "m.db"));

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "S",
    };

    const { gate } = await import("./index.js");
    await gate(
      ctx,
      { action: "shell", title: "Run", preview: 'git commit -m "broken commit"' },
      () => "error: nothing to commit\n[exit 1]",
    );

    const provisional = store.listProvisional();
    const hit = provisional.find((m) => m.kind === "milestone" && m.origin === "event");
    expect(hit).toBeUndefined();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});

describe("gate failure memory injection and reconsolidation", () => {
  it("injects memory when a failure matches a stored memory and records a recall_event", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const store = openMemoryStore(join(wd, "m.db"));
    const fakeError = "[error] pnpm add timed out behind proxy";
    const fp = (await import("../memory.js")).fingerprintError(fakeError);
    const id = store.insertMemory({ kind: "failure", cue: fp, triggerText: "pnpm add timed out behind proxy", body: "use --offline or configure proxy" });

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "sess-1",
    };

    // We need to simulate a command that returns a failing string whose fingerprint matches fp
    const fakeExec = () => fakeError;

    // Build an approval request consistent with run_shell signature
    const req = { action: "shell" as const, title: "Run command", preview: "pnpm add", preapproved: true };

    // Direct call to gate with our fake exec
    const { gate } = await import("./index.js");
    const out = await gate(ctx, req, fakeExec as any);
    expect(typeof out).toBe("string");
    expect(out.includes("[memory #")).toBe(true);

    // verify a recall_event was recorded
    // open the DB directly and check recall_events
    // (openMemoryStore uses same DB file)
    const recalls = store ? (store as any).listMemories() : [];
    // at least one recall_event should exist in the DB — use SQL via new connection
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(wd, "m.db"));
    const rows = db.prepare("SELECT * FROM recall_events").all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    db.close();

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });

  it("reconsolidation: second failure in same session decrements confidence", async () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-mem-"));
    const store = openMemoryStore(join(wd, "m.db"));
    const id = store.insertMemory({ kind: "failure", cue: "fp-2", triggerText: "boom", body: "fix: do X" });

    const ctx: ToolContext = {
      workdir: wd,
      config: cfg,
      confirm: async () => ({ approved: true }),
      memory: store,
      sessionId: "sess-2",
    };

    const fakeExec = () => "[error] boom";
    const { gate } = await import("./index.js");
    // first failure: inject and record
    await gate(ctx, { action: "shell" as const, title: "Run", preview: "cmd" }, fakeExec as any);
    // get confidence after first
    const before = store.listMemories().find((r) => r.id === id)!.confidence;
    // second failure in same session — should decrement confidence
    await gate(ctx, { action: "shell" as const, title: "Run", preview: "cmd" }, fakeExec as any);
    const after = store.listMemories().find((r) => r.id === id)!.confidence;
    expect(after).toBeLessThan(before);

    store.close();
    rmSync(wd, { recursive: true, force: true });
  });
});

describe("TOOL_INFO", () => {
  it("contains a run_subagent entry with action 'agent'", () => {
    const entry = TOOL_INFO.find((t) => t.name === "run_subagent");
    expect(entry).toBeDefined();
    expect(entry!.action).toBe("agent");
    expect(entry!.description).toContain("sub-agent");
  });
});
