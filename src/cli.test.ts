import { describe, it, expect } from "vitest";
import { runCli } from "./cli.js";

describe("runCli", () => {
  it("prints the version with --version", () => {
    const r = runCli(["--version"], "1.2.3");
    expect(r.output).toBe("1.2.3");
    expect(r.exitCode).toBe(0);
  });

  it("prints the version with -v", () => {
    expect(runCli(["-v"], "9.9.9").output).toBe("9.9.9");
  });

  it("prints help with --help", () => {
    const r = runCli(["--help"], "1.2.3");
    expect(r.output).toContain("Usage:");
    expect(r.exitCode).toBe(0);
  });

  it("exits 0 with a hint when no args are given", () => {
    const r = runCli([], "1.2.3");
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("1.2.3");
  });
});
