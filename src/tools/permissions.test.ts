import { describe, it, expect } from "vitest";
import type { PermissionsConfig } from "../config.js";
import { resolvePolicy, isShellDenied, isShellAllowed } from "./permissions.js";

function perms(over: Partial<PermissionsConfig> = {}): PermissionsConfig {
  return {
    mode: "supervised",
    overrides: {},
    shell: { deny: ["rm\\s+-rf\\s+/", "git\\s+push"], allow: [] },
    ...over,
  };
}

describe("resolvePolicy", () => {
  it("supervised: reads allow, writes/edits/shell ask", () => {
    const p = perms({ mode: "supervised" });
    expect(resolvePolicy(p, "read")).toBe("allow");
    expect(resolvePolicy(p, "write")).toBe("ask");
    expect(resolvePolicy(p, "edit")).toBe("ask");
    expect(resolvePolicy(p, "shell")).toBe("ask");
  });

  it("auto: everything allowed", () => {
    const p = perms({ mode: "auto" });
    for (const a of ["read", "write", "edit", "shell"] as const) {
      expect(resolvePolicy(p, a)).toBe("allow");
    }
  });

  it("readonly: writes/edits/shell denied", () => {
    const p = perms({ mode: "readonly" });
    expect(resolvePolicy(p, "read")).toBe("allow");
    expect(resolvePolicy(p, "write")).toBe("deny");
    expect(resolvePolicy(p, "shell")).toBe("deny");
  });

  it("per-action overrides win over the preset", () => {
    const p = perms({ mode: "auto", overrides: { shell: "ask" } });
    expect(resolvePolicy(p, "shell")).toBe("ask");
    expect(resolvePolicy(p, "write")).toBe("allow"); // preset still applies elsewhere
  });
});

describe("isShellDenied", () => {
  it("matches a denylisted command", () => {
    expect(isShellDenied(perms(), "sudo rm -rf /")).toBe(true);
    expect(isShellDenied(perms(), "git push origin main")).toBe(true);
  });

  it("allows a non-matching command", () => {
    expect(isShellDenied(perms(), "ls -la")).toBe(false);
  });

  it("ignores an invalid regex pattern instead of throwing", () => {
    const p = perms({ shell: { deny: ["([unclosed"], allow: [] } });
    expect(isShellDenied(p, "anything")).toBe(false);
  });
});

describe("isShellAllowed", () => {
  it("matches an allowlisted command", () => {
    const p = perms({ shell: { deny: [], allow: ["^git\\s+status", "^pnpm\\s+test"] } });
    expect(isShellAllowed(p, "git status")).toBe(true);
    expect(isShellAllowed(p, "pnpm test -- --watch=false")).toBe(true);
  });

  it("does not match other commands, and the default allowlist is empty", () => {
    const p = perms({ shell: { deny: [], allow: ["^git\\s+status"] } });
    expect(isShellAllowed(p, "git push origin main")).toBe(false);
    expect(isShellAllowed(perms(), "git status")).toBe(false);
  });

  it("ignores an invalid regex pattern instead of throwing", () => {
    const p = perms({ shell: { deny: [], allow: ["([unclosed"] } });
    expect(isShellAllowed(p, "anything")).toBe(false);
  });
});
