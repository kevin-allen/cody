import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOllama } from "@langchain/ollama";
import type { Config, ModelDef } from "../config.js";
import { modelDefForRole } from "../config.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export class ProviderError extends Error {}

// Whitespace and zero-width characters (U+200B..U+200D, U+FEFF, U+00A0) ride
// along invisibly when a key is copied from a web console or email. They are
// never part of a real key, so strip them rather than fail.
const INVISIBLE_CHARS = /[\s\u00A0\u200B-\u200D\uFEFF]/g;

function requireKey(env: NodeJS.ProcessEnv, name: string, provider: string): string {
  const value = (env[name] ?? "").replace(INVISIBLE_CHARS, "");
  if (!value) {
    throw new ProviderError(
      `Missing ${name} for the "${provider}" provider. Set it in your .env file (see .env.example).`,
    );
  }
  // HTTP header values must be Latin-1; a stray non-ASCII character would only
  // surface later as fetch's cryptic "Cannot convert argument to a ByteString".
  const bad = [...value].find((c) => c.charCodeAt(0) > 255);
  if (bad) {
    const code = bad.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
    throw new ProviderError(
      `${name} contains a non-ASCII character (U+${code}), likely picked up when the key was copied. Re-copy or retype it in .env.`,
    );
  }
  return value;
}

/**
 * Translate low-level request errors into actionable messages. fetch rejects a
 * non-Latin-1 HTTP header value with "Cannot convert argument to a ByteString"
 * — which in practice means an API key or configured header (e.g. an MCP
 * server header) contains an invisible non-ASCII character.
 */
export function describeRequestError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (msg.includes("Cannot convert argument to a ByteString")) {
    return (
      msg +
      "\n(an HTTP header contains a non-ASCII character — usually an API key in .env," +
      " or an MCP server header, copied with an invisible character; re-copy it)"
    );
  }
  return msg;
}

/** Construct a LangChain chat model from a model definition (FR-15). */
export function buildModel(def: ModelDef, env: NodeJS.ProcessEnv = process.env): BaseChatModel {
  switch (def.provider) {
    case "openai":
      return new ChatOpenAI({
        model: def.model,
        temperature: def.temperature,
        maxTokens: def.maxTokens,
        apiKey: requireKey(env, "OPENAI_API_KEY", "openai"),
      });
    case "anthropic":
      return new ChatAnthropic({
        model: def.model,
        temperature: def.temperature,
        maxTokens: def.maxTokens,
        apiKey: requireKey(env, "ANTHROPIC_API_KEY", "anthropic"),
      });
    case "ollama":
      return new ChatOllama({
        model: def.model,
        temperature: def.temperature,
        baseUrl: def.baseUrl ?? env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      });
    case "deepseek":
      // DeepSeek exposes an OpenAI-compatible API — reuse ChatOpenAI, pointed
      // at DeepSeek's base URL, with the DeepSeek key.
      return new ChatOpenAI({
        model: def.model,
        temperature: def.temperature,
        maxTokens: def.maxTokens,
        apiKey: requireKey(env, "DEEPSEEK_API_KEY", "deepseek"),
        configuration: {
          baseURL: def.baseUrl ?? env.DEEPSEEK_API_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
        },
      });
    default: {
      const exhaustive: never = def.provider;
      throw new ProviderError(`Unknown provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Structural tool-calling capability check (FR-17): every model cody drives
 * must expose `bindTools`. This catches a chat-model class that lacks tool
 * support; whether a specific local model actually emits tool calls is a
 * runtime property and is validated later, when the agent loop first runs.
 */
export function isToolCapable(model: BaseChatModel): boolean {
  return typeof (model as { bindTools?: unknown }).bindTools === "function";
}

export function assertToolCapable(model: BaseChatModel, label: string): void {
  if (!isToolCapable(model)) {
    throw new ProviderError(
      `The model configured for "${label}" does not support tool calling, which cody requires.`,
    );
  }
}

/** Resolve a role to a model definition and build the chat model. */
export function getModel(
  config: Config,
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): BaseChatModel {
  return buildModel(modelDefForRole(config, role), env);
}
