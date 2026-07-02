import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  modelDefForRole,
  DEFAULT_CONFIG,
  ConfigError,
  commandToAllowPattern,
  withShellAllowPattern,
  saveShellAllowPattern,
} from "./config.js";

describe("resolveConfig", () => {
  it("returns the defaults with no inputs", () => {
    const c = resolveConfig();
    expect(c.models.default).toEqual({ provider: "openai", model: "gpt-4o", temperature: 0 });
    expect(c.roles.agent).toBe("default");
    expect(c.permissions.mode).toBe("supervised");
  });

  it("merges a file config over defaults (per-model deep merge)", () => {
    const c = resolveConfig({
      fileConfig: {
        models: {
          default: { temperature: 0.5 }, // tweak only temperature
          deep: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        roles: { plan: "deep" },
      },
    });
    expect(c.models.default).toEqual({ provider: "openai", model: "gpt-4o", temperature: 0.5 });
    expect(c.models.deep).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(c.roles.plan).toBe("deep");
    expect(c.roles.agent).toBe("default"); // untouched default
  });

  it("applies env overrides over the file config", () => {
    const c = resolveConfig({
      fileConfig: { roles: { agent: "default" } },
      env: { CODY_AGENT_MODEL: "fast", CODY_MODE: "auto" },
    });
    expect(c.roles.agent).toBe("fast");
    expect(c.permissions.mode).toBe("auto");
  });

  it("injects OLLAMA_BASE_URL only into ollama models lacking one", () => {
    const c = resolveConfig({
      fileConfig: {
        models: {
          local: { provider: "ollama", model: "qwen2.5-coder" },
          pinned: { provider: "ollama", model: "llama3", baseUrl: "http://x:1" },
        },
      },
      env: { OLLAMA_BASE_URL: "http://host:11434" },
    });
    expect(c.models.local?.baseUrl).toBe("http://host:11434");
    expect(c.models.pinned?.baseUrl).toBe("http://x:1"); // explicit value preserved
    expect(c.models.default?.baseUrl).toBeUndefined(); // non-ollama untouched
  });

  it("lets CLI flags win over env", () => {
    const c = resolveConfig({
      env: { CODY_AGENT_MODEL: "fast", CODY_MODE: "supervised" },
      argv: ["--model", "deep", "--auto"],
    });
    expect(c.roles.agent).toBe("deep");
    expect(c.permissions.mode).toBe("auto");
  });

  it("ignores an invalid mode value", () => {
    const c = resolveConfig({ env: { CODY_MODE: "bogus" } });
    expect(c.permissions.mode).toBe(DEFAULT_CONFIG.permissions.mode);
  });
});

describe("modelDefForRole", () => {
  it("resolves an assigned role", () => {
    const c = resolveConfig({
      fileConfig: {
        models: { deep: { provider: "anthropic", model: "claude-opus-4-8" } },
        roles: { plan: "deep" },
      },
    });
    expect(modelDefForRole(c, "plan").model).toBe("claude-opus-4-8");
  });

  it("falls back to the default model for an unknown role", () => {
    const c = resolveConfig();
    expect(modelDefForRole(c, "does-not-exist")).toEqual(c.models.default);
  });

  it("throws when a role points at a missing model and there is no default", () => {
    const c = {
      models: {},
      roles: { agent: "ghost" },
      permissions: DEFAULT_CONFIG.permissions,
      limits: DEFAULT_CONFIG.limits,
      sessions: DEFAULT_CONFIG.sessions,
    };
    expect(() => modelDefForRole(c, "agent")).toThrow(/not in the catalog/);
  });

  it("throws (not silently falls back) when an assigned role names a missing model, even with a default present", () => {
    // e.g. a typo'd --model / CODY_AGENT_MODEL override
    const c = resolveConfig({ env: { CODY_AGENT_MODEL: "typo" } });
    expect(c.models.default).toBeDefined(); // default exists...
    expect(() => modelDefForRole(c, "agent")).toThrow(/not in the catalog/); // ...but we still error
  });
});

describe("limits.recursionLimit", () => {
  it("defaults to 200", () => {
    expect(resolveConfig().limits.recursionLimit).toBe(200);
  });

  it("can be overridden by the config file", () => {
    const c = resolveConfig({ fileConfig: { limits: { recursionLimit: 50 } } });
    expect(c.limits.recursionLimit).toBe(50);
  });

  it("ignores non-positive or non-integer values", () => {
    expect(resolveConfig({ fileConfig: { limits: { recursionLimit: 0 } } }).limits.recursionLimit).toBe(200);
    expect(resolveConfig({ fileConfig: { limits: { recursionLimit: -5 } } }).limits.recursionLimit).toBe(200);
    expect(resolveConfig({ fileConfig: { limits: { recursionLimit: 2.5 } } }).limits.recursionLimit).toBe(200);
  });
});

describe("sessions configuration", () => {
  it("defaults to enabled true and no path", () => {
    const c = resolveConfig();
    expect(c.sessions.enabled).toBe(true);
    expect(c.sessions.path).toBeUndefined();
  });

  it("can be overridden by the config file", () => {
    const c = resolveConfig({ fileConfig: { sessions: { enabled: false, path: "data/sessions.db" } } });
    expect(c.sessions.enabled).toBe(false);
    expect(c.sessions.path).toBe("data/sessions.db");
  });

  it("ignores invalid values and falls back to defaults", () => {
    const c = resolveConfig({ fileConfig: { sessions: { enabled: "yes" as unknown as boolean, path: "" } } });
    expect(c.sessions.enabled).toBe(DEFAULT_CONFIG.sessions.enabled);
    expect(c.sessions.path).toBeUndefined();
  });
});

describe("shell allowlist helpers (FR-22b)", () => {
  it("commandToAllowPattern anchors and escapes regex metacharacters", () => {
    const pattern = commandToAllowPattern("pnpm test -- --grep 'a.b (c)'");
    expect(pattern).toBe("^pnpm test -- --grep 'a\\.b \\(c\\)'$");
    const re = new RegExp(pattern);
    expect(re.test("pnpm test -- --grep 'a.b (c)'")).toBe(true);
    expect(re.test("pnpm test -- --grep 'aXb (c)'")).toBe(false);
    expect(re.test("pnpm test -- --grep 'a.b (c)' && rm -rf ~")).toBe(false);
  });

  it("withShellAllowPattern appends without mutating, and dedupes", () => {
    const base = resolveConfig();
    const c1 = withShellAllowPattern(base, "^echo hi$");
    expect(c1.permissions.shell.allow).toEqual(["^echo hi$"]);
    expect(base.permissions.shell.allow).toEqual([]); // original untouched
    expect(withShellAllowPattern(c1, "^echo hi$")).toBe(c1); // duplicate -> same config
  });

  it("saveShellAllowPattern creates cody.config.json when absent", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-cfg-"));
    try {
      saveShellAllowPattern(wd, "^echo hi$");
      const raw = JSON.parse(readFileSync(join(wd, "cody.config.json"), "utf8"));
      expect(raw.permissions.shell.allow).toEqual(["^echo hi$"]);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("saveShellAllowPattern appends, dedupes, and preserves other config fields", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-cfg-"));
    try {
      const path = join(wd, "cody.config.json");
      writeFileSync(
        path,
        JSON.stringify({
          models: { default: { provider: "ollama", model: "qwen3" } },
          permissions: { mode: "supervised", shell: { deny: ["x"], allow: ["^ls$"] } },
        }),
      );
      saveShellAllowPattern(wd, "^echo hi$");
      saveShellAllowPattern(wd, "^echo hi$"); // duplicate is a no-op
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.permissions.shell.allow).toEqual(["^ls$", "^echo hi$"]);
      expect(raw.permissions.shell.deny).toEqual(["x"]); // untouched
      expect(raw.models.default.model).toBe("qwen3"); // untouched
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it("saveShellAllowPattern throws on unparseable JSON instead of clobbering", () => {
    const wd = mkdtempSync(join(tmpdir(), "cody-cfg-"));
    try {
      const path = join(wd, "cody.config.json");
      writeFileSync(path, "{ not json");
      expect(() => saveShellAllowPattern(wd, "^echo hi$")).toThrow(ConfigError);
      expect(readFileSync(path, "utf8")).toBe("{ not json"); // file untouched
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
