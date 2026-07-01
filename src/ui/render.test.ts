import { describe, it, expect } from "vitest";
import { colorEnabled, makePalette, isAffirmative, formatDiff, formatApproval } from "./render.js";

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
