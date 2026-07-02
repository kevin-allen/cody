import { describe, it, expect } from "vitest";
import { parseSlash, isBareQuit } from "./repl.js";

describe("parseSlash", () => {
  it("recognizes /exit and /quit", () => {
    expect(parseSlash("/exit")).toBe("exit");
    expect(parseSlash("/quit")).toBe("exit");
  });
  it("recognizes /clear and /help (case-insensitive, trims)", () => {
    expect(parseSlash("/clear")).toBe("clear");
    expect(parseSlash("  /HELP  ")).toBe("help");
  });
  it("recognizes /usage", () => {
    expect(parseSlash("/usage")).toBe("usage");
    expect(parseSlash("  /UsAge  ")).toBe("usage");
  });
  it("recognizes /sessions", () => {
    expect(parseSlash("/sessions")).toBe("sessions");
    expect(parseSlash(" /SeSsIoNs  ")).toBe("sessions");
  });
  it("returns unknown for anything else", () => {
    expect(parseSlash("/frobnicate")).toBe("unknown");
    expect(parseSlash("/")).toBe("unknown");
  });
});

describe("isBareQuit", () => {
  it("matches a bare exit/quit (any case, trimmed)", () => {
    for (const s of ["exit", "quit", "EXIT", " Quit "]) expect(isBareQuit(s)).toBe(true);
  });
  it("does not match slash commands or longer messages", () => {
    for (const s of ["/exit", "exit the loop in foo()", "quitting time", ""]) {
      expect(isBareQuit(s)).toBe(false);
    }
  });
});
