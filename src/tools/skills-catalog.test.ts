import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsCatalog } from "../skills.js";

// NOTE: these skill-catalog tests were relocated here from tools/index.test.ts so
// that edits to the gate/tool tests cannot accidentally clobber them again.

let wd: string;

beforeEach(() => {
  wd = mkdtempSync(join(process.cwd(), "tmp-skills-"));
  mkdirSync(join(wd, ".cody"));
  mkdirSync(join(wd, ".cody", "skills"));
});

afterEach(() => rmSync(wd, { recursive: true, force: true }));

describe("skills catalog", () => {
  it("parses valid skill", () => {
    mkdirSync(join(wd!, ".cody", "skills", "foo"));
    writeFileSync(join(wd!, ".cody", "skills", "foo", "SKILL.md"), "---\nname: Foo\ndescription: bar\ntags: a,b\n---\nbody\n");
    const c = loadSkillsCatalog(wd as string);
    expect(c.length).toBe(1);
    expect(c[0]?.name).toBe("Foo");
  });

  it("missing frontmatter uses dir name", () => {
    mkdirSync(join(wd!, ".cody", "skills", "bar"));
    writeFileSync(join(wd!, ".cody", "skills", "bar", "SKILL.md"), "no frontmatter\n");
    const c = loadSkillsCatalog(wd as string);
    expect(c.length).toBe(1);
    expect(c[0]?.name).toBe("bar");
  });

  it("unreadable skipped", () => {
    mkdirSync(join(wd!, ".cody", "skills", "bad"));
    // don't create SKILL.md
    const c = loadSkillsCatalog(wd as string);
    expect(c.length).toBe(0);
  });
});

describe("skill tools", () => {
  it("load_skill and read_skill_file");
});
