import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config.js";
import type { Config } from "../config.js";
import { createTools } from "./index.js";
import type { ToolContext } from "./index.js";

let wd: string;

beforeEach(() => {
  wd = mkdtempSync(join(tmpdir(), "cody-reg-"));
  writeFileSync(join(wd, "f.txt"), "one\n");
});

afterEach(() => rmSync(wd, { recursive: true, force: true }));

function tools(config: Config, confirm = vi.fn(async () => true)) {
  const ctx: ToolContext = { workdir: wd, config, confirm };
  return {
    confirm,
    map: Object.fromEntries(createTools(ctx).map((t) => [t.name, t])),
  };
}

describe("permission gate through the tools", () => {
  it("supervised: write asks, then applies on approval", async () => {
    const { map, confirm } = tools(
      resolveConfig(),
      vi.fn(async () => true),
    );
    const res = await map.write_file!.invoke({ path: "g.txt", content: "hi" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(join(wd, "g.txt"))).toBe(true);
    expect(res).toContain("Wrote");
  });

  it("supervised: a rejected prompt does not write", async () => {
    const { map } = tools(
      resolveConfig(),
      vi.fn(async () => false),
    );
    const res = await map.write_file!.invoke({ path: "g.txt", content: "hi" });
    expect(existsSync(join(wd, "g.txt"))).toBe(false);
    expect(res).toContain("denied by user");
  });

  it("readonly: write is denied without asking", async () => {
    const { map, confirm } = tools(resolveConfig({ env: { CODY_MODE: "readonly" } }));
    const res = await map.write_file!.invoke({ path: "g.txt", content: "hi" });
    expect(confirm).not.toHaveBeenCalled();
    expect(res).toContain("[denied]");
    expect(existsSync(join(wd, "g.txt"))).toBe(false);
  });

  it("auto: write applies without asking", async () => {
    const { map, confirm } = tools(resolveConfig({ env: { CODY_MODE: "auto" } }));
    await map.write_file!.invoke({ path: "g.txt", content: "hi" });
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(join(wd, "g.txt"), "utf8")).toBe("hi");
  });

  it("read is allowed without asking", async () => {
    const { map, confirm } = tools(
      resolveConfig(),
      vi.fn(async () => false),
    );
    const res = await map.read_file!.invoke({ path: "f.txt" });
    expect(res).toContain("one");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shell denylist blocks even in auto mode", async () => {
    const { map } = tools(resolveConfig({ env: { CODY_MODE: "auto" } }));
    const res = await map.run_shell!.invoke({ command: "rm -rf /" });
    expect(res).toContain("[blocked]");
  });

  it("a path escape returns an error result, not a throw", async () => {
    const { map } = tools(resolveConfig());
    const res = await map.read_file!.invoke({ path: "../../etc/passwd" });
    expect(res).toContain("[error]");
    expect(res).toContain("escapes the working directory");
  });
});
