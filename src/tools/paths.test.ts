import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveWithinWorkdir, PathError } from "./paths.js";

const wd = "/home/user/project";

describe("resolveWithinWorkdir", () => {
  it("resolves a path inside the working directory", () => {
    expect(resolveWithinWorkdir(wd, "src/index.ts")).toBe(resolve(wd, "src/index.ts"));
  });

  it("allows the working directory itself", () => {
    expect(resolveWithinWorkdir(wd, ".")).toBe(resolve(wd));
  });

  it("rejects a traversal escape (../../etc/passwd)", () => {
    expect(() => resolveWithinWorkdir(wd, "../../etc/passwd")).toThrow(PathError);
  });

  it("rejects an absolute path outside the workdir", () => {
    expect(() => resolveWithinWorkdir(wd, "/etc/passwd")).toThrow(PathError);
  });

  it("rejects a bare parent reference", () => {
    expect(() => resolveWithinWorkdir(wd, "..")).toThrow(PathError);
  });

  it("does not reject a filename that merely starts with dots", () => {
    expect(resolveWithinWorkdir(wd, "..foo")).toBe(resolve(wd, "..foo"));
  });
});
