import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, withMcpServers, withMemories } from "./prompt.js";

describe("SYSTEM_PROMPT", () => {
  it("contains the parallel-tool-calls discipline line (FR-58)", () => {
    expect(SYSTEM_PROMPT).toContain("When tool calls are independent");
    expect(SYSTEM_PROMPT).toContain("issue them together in a single response so they run in parallel");
    expect(SYSTEM_PROMPT).toContain("keep dependent calls sequential");
  });

  it("mentions run_subagent delegation for broad explorations", () => {
    expect(SYSTEM_PROMPT).toContain("run_subagent");
    expect(SYSTEM_PROMPT).toContain("batch independent explorations into parallel run_subagent calls");
  });

  it("contains the output-hygiene discipline line (FR-62)", () => {
    expect(SYSTEM_PROMPT).toContain("When a command can produce long output, ask for the signal only");
    expect(SYSTEM_PROMPT).toContain("use quiet/failure-only test reporters");
    expect(SYSTEM_PROMPT).toContain("Verbose output is re-billed on every later model call");
  });
});

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
