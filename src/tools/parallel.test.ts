import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools, gate } from "./index.js";
import type { ToolContext, ApprovalRequest, ConfirmResult } from "./index.js";
import type { Config } from "../config.js";

const cfg: Config = {
  models: { default: { provider: "openai", model: "gpt-4o" } },
  roles: { agent: "default" },
  permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: [] } },
  limits: { recursionLimit: 10, compactThresholdTokens: 1000, evictThresholdTokens: 32768, keepRecentToolResults: 5, shellOutputMaxChars: 30000 },
  sessions: { enabled: true },
  mcp: { servers: {} },
};

// helper: create a serialized confirm (same pattern as repl.ts)
function serializedConfirm(
  raw: (req: ApprovalRequest) => Promise<ConfirmResult>,
): (req: ApprovalRequest) => Promise<ConfirmResult> {
  let chain: Promise<unknown> = Promise.resolve();
  return (req: ApprovalRequest): Promise<ConfirmResult> => {
    const p = chain.then(() => raw(req));
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
}

describe("parallel tool execution", () => {
  describe("confirm serialization", () => {
    it("serializes concurrent gate() calls so prompts are strictly sequential", async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const callOrder: string[] = [];

      const rawConfirm = async (req: ApprovalRequest): Promise<ConfirmResult> => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        callOrder.push(req.title);
        // small delay to allow overlap detection
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return { approved: true };
      };

      const confirm = serializedConfirm(rawConfirm);

      const ctx: ToolContext = {
        workdir: "/tmp",
        config: cfg,
        confirm,
      };

      const [r1, r2] = await Promise.all([
        gate(ctx, { action: "shell", title: "first", preview: "cmd1" }, () => "result1"),
        gate(ctx, { action: "shell", title: "second", preview: "cmd2" }, () => "result2"),
      ]);

      expect(maxConcurrent).toBe(1);
      expect(callOrder).toEqual(["first", "second"]);
      expect(r1).toBe("result1");
      expect(r2).toBe("result2");
    });

    it("denial does not wedge the queue: first confirm denies, second still runs", async () => {
      const callOrder: string[] = [];

      const rawConfirm = async (req: ApprovalRequest): Promise<ConfirmResult> => {
        callOrder.push(req.title);
        if (req.title === "first") return { approved: false, reason: "nope" };
        return { approved: true };
      };

      const confirm = serializedConfirm(rawConfirm);

      const ctx: ToolContext = {
        workdir: "/tmp",
        config: cfg,
        confirm,
      };

      const [r1, r2] = await Promise.all([
        gate(ctx, { action: "shell", title: "first", preview: "cmd1" }, () => "result1"),
        gate(ctx, { action: "shell", title: "second", preview: "cmd2" }, () => "result2"),
      ]);

      expect(callOrder).toEqual(["first", "second"]);
      expect(r1).toContain("denied");
      expect(r2).toBe("result2");
    });
  });

  describe("file lock", () => {
    it("serializes two concurrent edits on the same file so both succeed and the final file contains both changes", async () => {
      const wd = mkdtempSync(join(tmpdir(), "cody-parallel-"));
      const file = join(wd, "test.txt");
      writeFileSync(file, "line1\nline2\nline3\n", "utf8");

      const autoCfg: Config = {
        ...cfg,
        permissions: { ...cfg.permissions, mode: "auto" },
      };
      const ctx: ToolContext = {
        workdir: wd,
        config: autoCfg,
        confirm: async () => ({ approved: true }),
      };
      const tools = createTools(ctx);
      const editFile = tools.find((t) => t.name === "edit_file")!;

      // Both edits valid against original content; after the first edit,
      // the second old_string is still unique in the modified file.
      const [r1, r2] = await Promise.all([
        editFile.invoke({ path: "test.txt", old_string: "line1", new_string: "LINE1" }),
        editFile.invoke({ path: "test.txt", old_string: "line2", new_string: "LINE2" }),
      ]);

      expect(r1).toContain("Edited");
      expect(r2).toContain("Edited");

      const final = readFileSync(file, "utf8");
      expect(final).toContain("LINE1");
      expect(final).toContain("LINE2");

      rmSync(wd, { recursive: true, force: true });
    });

    it("allows two concurrent writes on different files to both succeed", async () => {
      const wd = mkdtempSync(join(tmpdir(), "cody-parallel-"));
      const autoCfg: Config = {
        ...cfg,
        permissions: { ...cfg.permissions, mode: "auto" },
      };
      const ctx: ToolContext = {
        workdir: wd,
        config: autoCfg,
        confirm: async () => ({ approved: true }),
      };
      const tools = createTools(ctx);
      const writeFile = tools.find((t) => t.name === "write_file")!;

      const [r1, r2] = await Promise.all([
        writeFile.invoke({ path: "a.txt", content: "A" }),
        writeFile.invoke({ path: "b.txt", content: "B" }),
      ]);

      expect(r1).toContain("Wrote");
      expect(r2).toContain("Wrote");
      expect(readFileSync(join(wd, "a.txt"), "utf8")).toBe("A");
      expect(readFileSync(join(wd, "b.txt"), "utf8")).toBe("B");

      rmSync(wd, { recursive: true, force: true });
    });

    it("does not serialize read tools: a read completes while a write holds the file lock", async () => {
      const wd = mkdtempSync(join(tmpdir(), "cody-parallel-"));
      writeFileSync(join(wd, "existing.txt"), "hello", "utf8");

      let writeConfirmResolve!: (v: ConfirmResult) => void;
      const writeConfirmPromise = new Promise<ConfirmResult>((resolve) => {
        writeConfirmResolve = resolve;
      });

      const confirm = async (req: ApprovalRequest): Promise<ConfirmResult> => {
        if (req.action === "write") {
          // hang until explicitly resolved
          return writeConfirmPromise;
        }
        return { approved: true };
      };

      // Override read to "ask" so the read also goes through confirm, proving
      // the file lock does not serialize it.
      const askCfg: Config = {
        ...cfg,
        permissions: { ...cfg.permissions, mode: "supervised", overrides: { read: "ask" } },
      };
      const ctx: ToolContext = {
        workdir: wd,
        config: askCfg,
        confirm,
      };
      const tools = createTools(ctx);
      const writeFile = tools.find((t) => t.name === "write_file")!;
      const readFile = tools.find((t) => t.name === "read_file")!;

      // Start a write — it will acquire the file lock then hang on confirm
      const writePromise = writeFile.invoke({ path: "new.txt", content: "data" });

      // Let the write acquire the lock and reach confirm
      await new Promise((r) => setTimeout(r, 10));

      // The read should complete even though the write holds the file lock
      // (the read's confirm resolves immediately, proving it's not queued behind the write)
      const readResult = await readFile.invoke({ path: "existing.txt" });
      expect(readResult).toContain("hello");

      // Resolve the write and verify it also succeeds
      writeConfirmResolve({ approved: true });
      const writeResult = await writePromise;
      expect(writeResult).toContain("Wrote");

      rmSync(wd, { recursive: true, force: true });
    });
  });
});
