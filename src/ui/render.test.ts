import { describe, it, expect } from "vitest";
import {
  colorEnabled,
  makePalette,
  isAffirmative,
  parseApprovalAnswer,
  formatDiff,
  formatApproval,
  formatSessionList,
} from "./render.js";
import type { SessionMeta } from "../sessions.js";

describe("colorEnabled", () => {
  it("is on for a TTY with no NO_COLOR", () => {
    expect(colorEnabled({}, true)).toBe(true);
  });
  it("is off when not a TTY", () => {
    expect(colorEnabled({}, false)).toBe(false);
  });
  it("is off when NO_COLOR is present, even empty, even on a TTY", () => {
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  });
});

describe("makePalette", () => {
  it("adds ANSI codes when enabled", () => {
    expect(makePalette(true).red("x")).toBe("\x1b[31mx\x1b[0m");
  });
  it("is identity when disabled", () => {
    const p = makePalette(false);
    expect(p.red("x")).toBe("x");
    expect(p.bold("y")).toBe("y");
  });
});

describe("isAffirmative", () => {
  it("accepts y / yes (any case)", () => {
    for (const a of ["y", "Y", "yes", "YES", " yes "]) expect(isAffirmative(a)).toBe(true);
  });
  it("rejects everything else (default no)", () => {
    for (const a of ["", "n", "no", "nope", "yeah", "sure"]) expect(isAffirmative(a)).toBe(false);
  });
});

describe("parseApprovalAnswer", () => {
  it("y / yes -> yes", () => {
    for (const a of ["y", "Y", "yes", " YES "]) expect(parseApprovalAnswer(a)).toBe("yes");
  });
  it("a / always -> always", () => {
    for (const a of ["a", "A", "always", " Always "]) expect(parseApprovalAnswer(a)).toBe("always");
  });
  it("everything else -> no (default)", () => {
    for (const a of ["", "n", "no", "all", "ay", "yes always"]) {
      expect(parseApprovalAnswer(a)).toBe("no");
    }
  });
});

describe("formatting (plain palette)", () => {
  const p = makePalette(false);

  it("formatDiff passes lines through when color is off", () => {
    expect(formatDiff("@@ -1 +1 @@\n-old\n+new", p)).toContain("+new");
  });

  it("formatApproval shows a $ command for shell actions", () => {
    const out = formatApproval({ action: "shell", title: "Run command", preview: "ls -la" }, p);
    expect(out).toContain("$ ls -la");
    expect(out).toContain("Run command");
  });

  it("formatApproval shows the diff for write actions", () => {
    const out = formatApproval(
      { action: "write", title: "Create x", preview: "@@ -0 +1 @@\n+hi" },
      p,
    );
    expect(out).toContain("+hi");
  });
});

describe("formatSessionList", () => {
  const p = makePalette(false);
  it("returns (no sessions) for empty list", () => {
    expect(formatSessionList([], p)).toBe("(no sessions)\n");
  });

  it("marks current session and formats lines", () => {
    const s: SessionMeta[] = [
      { id: "s-one", createdAt: "", updatedAt: "u1", preview: "preview1", title: "", inputTokens: 1, outputTokens: 2 },
      { id: "s-two", createdAt: "", updatedAt: "u2", preview: "preview2", title: "", inputTokens: 3, outputTokens: 4 },
    ];
    const out = formatSessionList(s, p, "s-two");
    // two lines plus trailing newline
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    // first line corresponds to s-one (index 1)
    expect(lines[0]).toContain("1 ");
    expect(lines[0]).toContain("s-one");
    // second line marked current with "*"
    expect(lines[1]).toContain("*");
    expect(lines[1]).toContain("s-two");
  });

  it("shows title when present and falls back to preview when empty", () => {
    const s: SessionMeta[] = [
      { id: "s-one", createdAt: "", updatedAt: "u1", preview: "preview1", title: "A Title", inputTokens: 1, outputTokens: 2 },
      { id: "s-two", createdAt: "", updatedAt: "u2", preview: "preview2", title: "", inputTokens: 3, outputTokens: 4 },
    ];
    const out = formatSessionList(s, p);
    const lines = out.trim().split("\n");
    // first line should contain the title and not the preview
    expect(lines[0]).toContain("A Title");
    expect(lines[0]).not.toContain("preview1");
    // second line should contain the preview because title is empty
    expect(lines[1]).toContain("preview2");
  });
});
