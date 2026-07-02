import type { PermissionsConfig, PermissionMode, ToolAction, ActionPolicy } from "../config.js";

/** Per-action policy for each mode preset (FR-19). */
const PRESETS: Record<PermissionMode, Record<ToolAction, ActionPolicy>> = {
  supervised: { read: "allow", write: "ask", edit: "ask", shell: "ask" },
  auto: { read: "allow", write: "allow", edit: "allow", shell: "allow" },
  readonly: { read: "allow", write: "deny", edit: "deny", shell: "deny" },
};

/** Resolve the effective policy for an action: preset, then per-action override. */
export function resolvePolicy(permissions: PermissionsConfig, action: ToolAction): ActionPolicy {
  return permissions.overrides[action] ?? PRESETS[permissions.mode][action];
}

/** Whether a command matches any pattern. Invalid regexes are ignored rather than throwing. */
function matchesAny(patterns: readonly string[], command: string): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
}

/**
 * Whether a shell command matches the denylist. Applies in EVERY mode,
 * including `auto` — a denylist match always wins over the policy (FR-22).
 */
export function isShellDenied(permissions: PermissionsConfig, command: string): boolean {
  return matchesAny(permissions.shell.deny, command);
}

/**
 * Whether a shell command matches the allowlist. An allowlisted command skips
 * the `ask` prompt (FR-22a) — but the denylist still wins over it, and it never
 * upgrades a `deny` policy (e.g. `readonly` mode).
 */
export function isShellAllowed(permissions: PermissionsConfig, command: string): boolean {
  return matchesAny(permissions.shell.allow, command);
}
