import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileWithin,
  listDirWithin,
  globWithin,
  grepWithin,
  prepareWrite,
  prepareEdit,
} from "./fs.js";

let wd: string;

beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), "cody-fs-"));
  mkdirSync(join(wd, "src"));
  writeFileSync(
    join(wd, "src", "a.ts"),
    "export const a = 1;\nconst dupe = 0;\nconst dupe2 = 0;\n",
  );
  writeFileSync(join(wd, "README.md"), "# hello\nworld\n");
});

afterEach(() => rmSync(wd, { recursive: true, force: true }));

describe("read/list/glob/grep", () => {
  it("reads a file", () => {
    expect(readFileWithin(wd, "README.md")).toContain("hello");
  });

  it("lists a directory with dirs suffixed by /", () => {
    const out = listDirWithin(wd, ".");
    expect(out).toContain("src/");
    expect(out).toContain("README.md");
  });

  it("globs files", async () => {
    expect(await globWithin(wd, "**/*.ts")).toContain("src/a.ts");
  });

  it("greps content, reporting file:line:", () => {
    expect(grepWithin(wd, "hello")).toMatch(/README\.md:1:/);
  });

  it("rejects reads outside the workdir", () => {
    expect(() => readFileWithin(wd, "../../etc/passwd")).toThrow();
  });
});

describe("prepareWrite", () => {
  it("creates a new file only on apply()", () => {
    const c = prepareWrite(wd, "new.txt", "hi\n");
    expect(c.summary).toMatch(/^Create /);
    expect(existsSync(join(wd, "new.txt"))).toBe(false);
    c.apply();
    expect(readFileSync(join(wd, "new.txt"), "utf8")).toBe("hi\n");
  });

  it("reports Overwrite and a diff for an existing file", () => {
    const c = prepareWrite(wd, "README.md", "# hello\nchanged\n");
    expect(c.summary).toMatch(/^Overwrite /);
    expect(c.diff).toContain("changed");
  });
});

describe("prepareEdit", () => {
  it("replaces a unique occurrence on apply()", () => {
    prepareEdit(wd, "README.md", "world", "earth").apply();
    expect(readFileSync(join(wd, "README.md"), "utf8")).toContain("earth");
  });

  it("throws when old_string is missing", () => {
    expect(() => prepareEdit(wd, "README.md", "nope", "x")).toThrow(/not found/);
  });

  it("throws when old_string is not unique", () => {
    expect(() => prepareEdit(wd, "src/a.ts", "const dupe", "x")).toThrow(/must be unique/);
  });

  it("throws on an empty old_string", () => {
    expect(() => prepareEdit(wd, "README.md", "", "x")).toThrow(/must not be empty/);
  });
});
