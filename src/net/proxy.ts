import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

const PROXY_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** True if any standard proxy environment variable is set. */
export function hasProxyConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_VARS.some((name) => Boolean(env[name]));
}

/**
 * Route the SDK HTTP clients (which use Node's global fetch) through the
 * standard proxy env vars when set. `EnvHttpProxyAgent` reads HTTP(S)_PROXY and
 * honors NO_PROXY per host, so local providers (e.g. Ollama on localhost)
 * bypass the proxy. No-op when no proxy is configured. Returns true if a proxy
 * dispatcher was installed.
 */
export function configureProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hasProxyConfig(env)) return false;

  // Silence undici's one-time "EnvHttpProxyAgent is experimental" warning so it
  // doesn't clutter the terminal on every run.
  const original = process.emitWarning.bind(process);
  const filtered = (warning: string | Error, ...args: unknown[]): void => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("EnvHttpProxyAgent")) return;
    (original as (w: string | Error, ...a: unknown[]) => void)(warning, ...args);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } finally {
    process.emitWarning = original;
  }
  return true;
}

/**
 * Replace the global dispatcher with one that relaxes TLS certificate
 * verification for outbound requests. This is intentionally process-global
 * and should only be called when the user explicitly asked to allow
 * insecure TLS (e.g. via config). Writes a one-line warning to stderr.
 */
export function relaxTlsVerification(): void {
  // Create an EnvHttpProxyAgent that disables TLS verification for requests
  // and for CONNECT/TLS.
  // EnvHttpProxyAgent's TS options may not expose the nested TLS options in this
  // version, so cast through unknown to set them as requested by the feature spec.
  const agent = new EnvHttpProxyAgent({ requestTls: { rejectUnauthorized: false }, connect: { rejectUnauthorized: false } } as unknown as Record<string, unknown>);
  setGlobalDispatcher(agent as unknown as import("undici").Agent);
  // One-line warning to stderr
  process.stderr.write("Warning: TLS verification is disabled for this process.\n");
}
