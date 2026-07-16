import { describe, it, expect } from "vitest";
import { runShell } from "./shell.js";

const workdir = process.cwd();

describe("runShell", () => {
  it("returns stdout and exit 0 for a successful command", async () => {
    const result = await runShell(workdir, "echo hello");
    expect(result).toContain("hello");
    expect(result).toContain("[exit 0]");
  });

  it("reports the actual non-zero exit code", async () => {
    const result = await runShell(workdir, "exit 3");
    expect(result).toContain("[exit 3]");
  });

  it("captures stderr", async () => {
    const result = await runShell(workdir, "echo oops 1>&2; exit 1");
    expect(result).toContain("[stderr]");
    expect(result).toContain("oops");
    expect(result).toContain("[exit 1]");
  });

  it("times out when the command exceeds timeoutMs", async () => {
    const result = await runShell(workdir, "sleep 1", { timeoutMs: 50 });
    expect(result).toContain("timed out");
  });
});

describe("runShell output cap", () => {
  it("caps long output with the limit-hit marker and preserves [exit N]", async () => {
    // Produce ~2000 chars of output, cap at 500.
    const result = await runShell(
      workdir,
      "node -e \"process.stdout.write('A'.repeat(2000))\"",
      { outputMaxChars: 500 },
    );
    expect(result.length).toBeLessThanOrEqual(550); // allow small overflow from marker
    expect(result).toContain("[output truncated: hit the 500-char limit");
    expect(result).toContain("chars omitted; narrow the command's output]");
    expect(result).toContain("[exit 0]");
    // The exit marker should be at the very end.
    expect(result.trimEnd()).toMatch(/\[exit 0\]$/);
  });

  it("leaves short output untouched", async () => {
    const result = await runShell(workdir, "echo hi", { outputMaxChars: 5000 });
    expect(result).toContain("hi");
    expect(result).toContain("[exit 0]");
    expect(result).not.toContain("truncated");
  });

  it("0 disables the cap", async () => {
    // Even with a tiny "cap" of 0, output is not truncated.
    const result = await runShell(
      workdir,
      "node -e \"process.stdout.write('A'.repeat(2000))\"",
      { outputMaxChars: 0 },
    );
    expect(result).toContain("A");
    expect(result).toContain("[exit 0]");
    expect(result).not.toContain("truncated");
  });

  it("preserves [exit N] marker even with stderr output", async () => {
    const result = await runShell(
      workdir,
      "node -e \"process.stderr.write('B'.repeat(200)); process.stdout.write('A'.repeat(200))\"",
      { outputMaxChars: 100 },
    );
    expect(result).toContain("[output truncated");
    expect(result).toContain("[exit 0]");
    expect(result.trimEnd()).toMatch(/\[exit 0\]$/);
  });

  it("preserves [exit N] marker for non-zero exit codes", async () => {
    const result = await runShell(
      workdir,
      "node -e \"process.stdout.write('A'.repeat(2000)); process.exit(1)\"",
      { outputMaxChars: 500 },
    );
    expect(result).toContain("[output truncated");
    expect(result.trimEnd()).toMatch(/\[exit 1\]$/);
  });
});
