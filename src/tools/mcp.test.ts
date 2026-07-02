import { describe, it, expect, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolContext } from "./index.js";

// We'll create fake raw tools using tool() and then wrap them with our gating.
function makeRawTool(name: string, fn: (args: unknown) => unknown): StructuredToolInterface {
  return tool((args) => Promise.resolve(fn(args)), {
    name,
    description: "desc",
    schema: z.object({}).passthrough(),
  });
}

describe("createGatedMcpTools", () => {
  it("asks in supervised mode when not preapproved", async () => {
    const called: unknown[] = [];
    const confirm = vi.fn(async (req: unknown) => {
      called.push(req);
      return { approved: true };
    });
    const ctx = { config: { permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: [] } } }, confirm } as unknown as ToolContext;

    const raw = [makeRawTool("s__t", (_args) => "ok")];
    // import wrapper dynamically from src/tools/index.ts
    const { createGatedMcpTools } = await import("./index.js");
    const wrapped = createGatedMcpTools(ctx, raw);
    const res = await wrapped[0]!.invoke({});
    expect(res).toBe("ok");
    expect(confirm).toHaveBeenCalled();
  });

  it("denylist blocks even in auto mode without confirm", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const ctx = { config: { permissions: { mode: "auto", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: ["blocked-tool"], allow: [] } } }, confirm } as unknown as ToolContext;
    const raw = [makeRawTool("srv__blocked-tool", (_args) => "should-not-run")];
    const { createGatedMcpTools } = await import("./index.js");
    const wrapped = createGatedMcpTools(ctx, raw);
    const res = await wrapped[0]!.invoke({});
    expect(res).toBe("[blocked] MCP tool srv__blocked-tool matches the mcp denylist");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("allowlist skips confirm in supervised mode", async () => {
    const confirm = vi.fn(async () => ({ approved: false }));
    const ctx = { config: { permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: ["^good-.*"] } } }, confirm } as unknown as ToolContext;
    const raw = [makeRawTool("srv__good-tool", (_args) => ({ result: { x: 1 } }))];
    const { createGatedMcpTools } = await import("./index.js");
    const wrapped = createGatedMcpTools(ctx, raw);
    const res = await wrapped[0]!.invoke({});
    // non-string result should be stringified
    expect(res).toBe(JSON.stringify({ result: { x: 1 } }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("passes through names, descriptions, and schemas", async () => {
    const confirm = vi.fn(async () => ({ approved: true }));
    const ctx = { config: { permissions: { mode: "supervised", overrides: {}, shell: { deny: [], allow: [] }, mcp: { deny: [], allow: [] } } }, confirm } as unknown as ToolContext;
    const raw = [makeRawTool("srv__t2", (_args) => "x")];
    const { createGatedMcpTools } = await import("./index.js");
    const wrapped = createGatedMcpTools(ctx, raw);
    expect(wrapped[0]!.name).toBe("srv__t2");
    expect(wrapped[0]!.description).toBe("desc");
    expect(wrapped[0]!.invoke).toBeDefined();
  });
});
