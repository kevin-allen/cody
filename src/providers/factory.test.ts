import { describe, it, expect } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOllama } from "@langchain/ollama";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  buildModel,
  getModel,
  isToolCapable,
  assertToolCapable,
  ProviderError,
} from "./factory.js";
import { resolveConfig } from "../config.js";

const KEYS = { OPENAI_API_KEY: "test-openai", ANTHROPIC_API_KEY: "test-anthropic" };

describe("buildModel", () => {
  it("builds a ChatOpenAI for the openai provider", () => {
    const m = buildModel({ provider: "openai", model: "gpt-4o", temperature: 0 }, KEYS);
    expect(m).toBeInstanceOf(ChatOpenAI);
  });

  it("builds a ChatAnthropic for the anthropic provider", () => {
    const m = buildModel({ provider: "anthropic", model: "claude-opus-4-8" }, KEYS);
    expect(m).toBeInstanceOf(ChatAnthropic);
  });

  it("builds a ChatOllama with no API key required", () => {
    const m = buildModel({ provider: "ollama", model: "qwen2.5-coder", baseUrl: "http://x:1" }, {});
    expect(m).toBeInstanceOf(ChatOllama);
  });

  it("throws a clear error when the required API key is missing", () => {
    expect(() => buildModel({ provider: "openai", model: "gpt-4o" }, {})).toThrow(ProviderError);
    expect(() => buildModel({ provider: "openai", model: "gpt-4o" }, {})).toThrow(/OPENAI_API_KEY/);
  });
});

describe("getModel", () => {
  it("resolves a role through the config and builds the model", () => {
    const config = resolveConfig();
    const m = getModel(config, "agent", KEYS);
    expect(m).toBeInstanceOf(ChatOpenAI);
  });
});

describe("tool-capability check", () => {
  it("passes for real chat models (they expose bindTools)", () => {
    const m = buildModel({ provider: "ollama", model: "qwen2.5-coder" }, {});
    expect(isToolCapable(m)).toBe(true);
    expect(() => assertToolCapable(m, "agent")).not.toThrow();
  });

  it("fails for a model without bindTools", () => {
    const fake = {} as BaseChatModel;
    expect(isToolCapable(fake)).toBe(false);
    expect(() => assertToolCapable(fake, "agent")).toThrow(/tool calling/);
  });
});
