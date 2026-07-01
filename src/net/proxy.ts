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
