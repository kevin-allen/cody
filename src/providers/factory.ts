import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOllama } from "@langchain/ollama";
import type { Config, ModelDef } from "../config.js";
import { modelDefForRole } from "../config.js";

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export class ProviderError extends Error {}

function requireKey(env: NodeJS.ProcessEnv, name: string, provider: string): string {
  const value = env[name];
  if (!value) {
    throw new ProviderError(
      `Missing ${name} for the "${provider}" provider. Set it in your .env file (see .env.example).`,
    );
  }
  return value;
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
