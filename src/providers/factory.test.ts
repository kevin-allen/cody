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
  describeRequestError,
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

  it("builds an (OpenAI-compatible) ChatOpenAI for the deepseek provider", () => {
    const m = buildModel(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { DEEPSEEK_API_KEY: "test-deepseek" },
    );
    expect(m).toBeInstanceOf(ChatOpenAI);
  });

  it("throws a clear error when the required API key is missing", () => {
    expect(() => buildModel({ provider: "openai", model: "gpt-4o" }, {})).toThrow(ProviderError);
    expect(() => buildModel({ provider: "openai", model: "gpt-4o" }, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => buildModel({ provider: "deepseek", model: "deepseek-v4-pro" }, {})).toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });

  it("strips whitespace and zero-width characters copied into a key", () => {
    // U+200B zero-width space at the front, trailing newline — both survive a
    // copy-paste into .env invisibly and would poison the Authorization header.
    const m = buildModel(
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { DEEPSEEK_API_KEY: "\u200Bsk-test\n" },
    ) as ChatOpenAI;
    expect(m.apiKey).toBe("sk-test");
  });

  it("treats a key that is only invisible characters as missing", () => {
    expect(() =>
      buildModel({ provider: "openai", model: "gpt-4o" }, { OPENAI_API_KEY: "\u200B \uFEFF" }),
    ).toThrow(/Missing OPENAI_API_KEY/);
  });

  it("names the env var and offending codepoint for a non-ASCII key", () => {
    expect(() =>
      buildModel({ provider: "openai", model: "gpt-4o" }, { OPENAI_API_KEY: "sk-téstéx" }),
    ).not.toThrow(); // Latin-1 (≤ U+00FF) is header-safe — only chars above 255 are rejected
    expect(() =>
      buildModel({ provider: "openai", model: "gpt-4o" }, { OPENAI_API_KEY: "sk-\u2192test" }),
    ).toThrow(/OPENAI_API_KEY contains a non-ASCII character \(U\+2192\)/);
  });
});

describe("describeRequestError", () => {
  it("points a ByteString header error at the API keys", () => {
    const err = new TypeError(
      "Cannot convert argument to a ByteString because the character at index 7 has a value of 8203 which is greater than 255.",
    );
    const msg = describeRequestError(err);
    expect(msg).toContain("ByteString");
    expect(msg).toMatch(/API key in \.env/);
  });

  it("passes other errors through unchanged", () => {
    expect(describeRequestError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
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
