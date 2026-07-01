import { describe, it, expect } from "vitest";
import { hasProxyConfig } from "./proxy.js";

describe("hasProxyConfig", () => {
  it("is false when no proxy vars are set", () => {
    expect(hasProxyConfig({})).toBe(false);
  });

  it("detects HTTPS_PROXY", () => {
    expect(hasProxyConfig({ HTTPS_PROXY: "http://proxy:80" })).toBe(true);
  });

  it("detects lowercase http_proxy", () => {
    expect(hasProxyConfig({ http_proxy: "http://proxy:3128" })).toBe(true);
  });

  it("ignores unrelated vars", () => {
    expect(hasProxyConfig({ NO_PROXY: "localhost", PATH: "/usr/bin" })).toBe(false);
  });
});
