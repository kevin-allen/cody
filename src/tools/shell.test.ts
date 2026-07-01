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
