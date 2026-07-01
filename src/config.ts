import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ProviderName = "openai" | "anthropic" | "ollama";

export interface ModelDef {
  readonly provider: ProviderName;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Ollama server URL; ignored by other providers. */
  readonly baseUrl?: string;
}

export type PermissionMode = "supervised" | "auto" | "readonly";
export type ToolAction = "read" | "write" | "edit" | "shell";
export type ActionPolicy = "allow" | "ask" | "deny";

export interface PermissionsConfig {
  readonly mode: PermissionMode;
  readonly overrides: Partial<Record<ToolAction, ActionPolicy>>;
  readonly shell: { readonly deny: readonly string[] };
}

export interface Config {
  /** Named model catalog. Must contain a "default" entry. */
  readonly models: Record<string, ModelDef>;
  /** Task role -> model name in the catalog. */
  readonly roles: Record<string, string>;
  readonly permissions: PermissionsConfig;
}

export const DEFAULT_CONFIG: Config = {
  models: {
    default: { provider: "openai", model: "gpt-4o", temperature: 0 },
  },
  roles: { agent: "default" },
  permissions: {
    mode: "supervised",
    overrides: {},
    shell: { deny: ["rm\\s+-rf\\s+/", "git\\s+push", ":\\(\\)\\s*\\{"] },
  },
};

const PERMISSION_MODES: readonly PermissionMode[] = ["supervised", "auto", "readonly"];

export class ConfigError extends Error {}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface ResolveInputs {
  readonly fileConfig?: DeepPartial<Config>;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
}

/**
 * Merge the layers in precedence order (later wins):
 * built-in defaults -> config file -> environment -> CLI flags.
 * Pure: no filesystem or process access.
 */
export function resolveConfig(inputs: ResolveInputs = {}): Config {
  const { fileConfig = {}, env = {}, argv = [] } = inputs;

  // --- defaults <- file ---
  const models: Record<string, ModelDef> = { ...DEFAULT_CONFIG.models };
  for (const [name, def] of Object.entries(fileConfig.models ?? {})) {
    if (!def) continue;
    models[name] = { ...models[name], ...def } as ModelDef;
  }

  const roles: Record<string, string> = { ...DEFAULT_CONFIG.roles };
  for (const [role, name] of Object.entries(fileConfig.roles ?? {})) {
    if (typeof name === "string") roles[role] = name;
  }

  const filePerms = fileConfig.permissions ?? {};
  let permissions: PermissionsConfig = {
    mode: coerceMode(filePerms.mode) ?? DEFAULT_CONFIG.permissions.mode,
    overrides: { ...DEFAULT_CONFIG.permissions.overrides, ...(filePerms.overrides ?? {}) },
    shell: { deny: filePerms.shell?.deny ?? DEFAULT_CONFIG.permissions.shell.deny },
  };

  // --- environment overrides ---
  const ollamaBaseUrl = env.OLLAMA_BASE_URL;
  if (ollamaBaseUrl) {
    for (const [name, def] of Object.entries(models)) {
      if (def.provider === "ollama" && def.baseUrl === undefined) {
        models[name] = { ...def, baseUrl: ollamaBaseUrl };
      }
    }
  }
  if (env.CODY_AGENT_MODEL) roles.agent = env.CODY_AGENT_MODEL;
  const envMode = coerceMode(env.CODY_MODE);
  if (envMode) permissions = { ...permissions, mode: envMode };

  // --- CLI flag overrides (highest precedence) ---
  const flags = parseFlags(argv);
  if (flags.model) roles.agent = flags.model;
  if (flags.mode) permissions = { ...permissions, mode: flags.mode };

  return { models, roles, permissions };
}

interface Flags {
  model?: string;
  mode?: PermissionMode;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      const next = argv[i + 1];
      if (next !== undefined) {
        flags.model = next;
        i++;
      }
    } else if (arg === "--mode") {
      const next = coerceMode(argv[i + 1]);
      if (next) {
        flags.mode = next;
        i++;
      }
    } else if (arg === "--auto") {
      flags.mode = "auto";
    } else if (arg === "--readonly") {
      flags.mode = "readonly";
    }
  }
  return flags;
}

function coerceMode(value: string | undefined): PermissionMode | undefined {
  return value !== undefined && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : undefined;
}

/**
 * Resolve the model definition for a role. An unknown/unassigned role falls
 * back to the model named "default" (FR-14).
 */
export function modelDefForRole(config: Config, role: string): ModelDef {
  const assigned = config.roles[role];
  if (assigned !== undefined) {
    // A role explicitly pointing at a missing model is a misconfiguration
    // (e.g. a typo in --model / CODY_AGENT_MODEL), not a fallback case.
    const def = config.models[assigned];
    if (!def) {
      throw new ConfigError(
        `Role "${role}" points at model "${assigned}", which is not in the catalog.`,
      );
    }
    return def;
  }
  // Unassigned role -> the "default" model (FR-14).
  const fallback = config.models["default"];
  if (!fallback) {
    throw new ConfigError(
      `Role "${role}" is unassigned and there is no "default" model in the catalog.`,
    );
  }
  return fallback;
}

const CONFIG_FILENAME = "cody.config.json";

/** Read cody.config.json from a directory, if present. Returns undefined if absent. */
export function loadConfigFile(cwd: string): DeepPartial<Config> | undefined {
  const path = resolve(cwd, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // no config file
  }
  try {
    return JSON.parse(raw) as DeepPartial<Config>;
  } catch (err) {
    throw new ConfigError(`Failed to parse ${CONFIG_FILENAME}: ${(err as Error).message}`);
  }
}

export interface LoadInputs {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
}

/** Load and resolve config from disk + environment + flags. */
export function loadConfig(inputs: LoadInputs): Config {
  return resolveConfig({
    fileConfig: loadConfigFile(inputs.cwd),
    env: inputs.env,
    argv: inputs.argv,
  });
}
