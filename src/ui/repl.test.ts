import { describe, it, expect } from "vitest";
import { parseSlash } from "./repl.js";

describe("parseSlash", () => {
  it("recognizes /exit and /quit", () => {
    expect(parseSlash("/exit")).toBe("exit");
    expect(parseSlash("/quit")).toBe("exit");
  });
  it("recognizes /clear and /help (case-insensitive, trims)", () => {
    expect(parseSlash("/clear")).toBe("clear");
    expect(parseSlash("  /HELP  ")).toBe("help");
  });
  it("returns unknown for anything else", () => {
    expect(parseSlash("/frobnicate")).toBe("unknown");
    expect(parseSlash("/")).toBe("unknown");
  });
});
