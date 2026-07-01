import { describe, it, expect } from "vitest";
import { resolveConfig, modelDefForRole, DEFAULT_CONFIG } from "./config.js";

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
    const c = { models: {}, roles: { agent: "ghost" }, permissions: DEFAULT_CONFIG.permissions };
    expect(() => modelDefForRole(c, "agent")).toThrow(/not in the catalog/);
  });

  it("throws (not silently falls back) when an assigned role names a missing model, even with a default present", () => {
    // e.g. a typo'd --model / CODY_AGENT_MODEL override
    const c = resolveConfig({ env: { CODY_AGENT_MODEL: "typo" } });
    expect(c.models.default).toBeDefined(); // default exists...
    expect(() => modelDefForRole(c, "agent")).toThrow(/not in the catalog/); // ...but we still error
  });
});
