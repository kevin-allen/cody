import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, withMcpServers } from "./prompt.js";

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
