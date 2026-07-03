import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, withMcpServers, withMemories } from "./prompt.js";

describe("withMcpServers (FR-44a)", () => {
  it("returns the base prompt unchanged for an empty list", () => {
    expect(withMcpServers(SYSTEM_PROMPT, [])).toBe(SYSTEM_PROMPT);
  });

  it("appends one line per server with tools and description", () => {
    const out = withMcpServers(SYSTEM_PROMPT, [
      { name: "skin-mcp", description: "Lab GitLab index.", toolNames: ["list_repos", "search"] },
      { name: "other", toolNames: ["t1"] },
    ]);
    expect(out).toContain("## Connected MCP servers");
    expect(out).toContain("skin-mcp");
    expect(out).toContain("list_repos");
    expect(out).toContain("Lab GitLab index.");
    expect(out).toContain("other");
  });
});

describe("withMemories", () => {
  it("returns base unchanged for empty", () => {
    const base = "hello";
    expect(withMemories(base, [])).toBe(base);
  });

  it("appends the remembered context for one memory", () => {
    const base = "start";
    const mem = [{ id: 1, kind: "decision", cue: "c", triggerText: "t", body: "we chose X because Y", scope: null, confidence: 2, uses: 1, lastUsed: null, created: "", sourceSession: null }];
    const out = withMemories(base, mem as any);
    expect(out).toContain("## Remembered context");
    expect(out).toContain("[memory #");
    expect(out).toContain("we chose X because Y");
  });
});
