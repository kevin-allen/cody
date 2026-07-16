import { describe, it, expect } from "vitest";
import { parseSlash, isBareQuit, formatUsageLine } from "./repl.js";

// Adjust tests to the new parseSlash signature returning { cmd, arg? }

describe("parseSlash", () => {
  it("recognizes /exit and /quit", () => {
    expect(parseSlash("/exit").cmd).toBe("exit");
    expect(parseSlash("/quit").cmd).toBe("exit");
  });
  it("recognizes /clear and /help (case-insensitive, trims)", () => {
    expect(parseSlash("/clear").cmd).toBe("clear");
    expect(parseSlash("  /HELP  ").cmd).toBe("help");
  });
  it("recognizes /usage", () => {
    expect(parseSlash("/usage").cmd).toBe("usage");
    expect(parseSlash("  /UsAge  ").cmd).toBe("usage");
  });
  it("recognizes /sessions", () => {
    expect(parseSlash("/sessions").cmd).toBe("sessions");
    expect(parseSlash(" /SeSsIoNs  ").cmd).toBe("sessions");
  });
  it("returns unknown for anything else", () => {
    expect(parseSlash("/frobnicate").cmd).toBe("unknown");
    expect(parseSlash("/").cmd).toBe("unknown");
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

describe("parseSlash with args (resume)", () => {
  it("parses /resume with no arg", () => {
    const p = parseSlash("/resume");
    expect(p.cmd).toBe("resume");
    expect(p.arg).toBeUndefined();
  });
  it("parses /resume with arg preserved", () => {
    const p = parseSlash("/resume ABC");
    expect(p.cmd).toBe("resume");
    expect(p.arg).toBe("ABC");
  });
});

describe("parseSlash with args (title)", () => {
  it("parses /title with no arg", () => {
    const p = parseSlash("/title");
    expect(p.cmd).toBe("title");
    expect(p.arg).toBeUndefined();
  });
  it("parses /title with arg preserved verbatim", () => {
    const p = parseSlash('/title  My Title with  spaces\n ');
    expect(p.cmd).toBe("title");
    expect(p.arg).toBe("My Title with  spaces");
  });
});

describe("parseSlash compact", () => {
  it("parses /compact", () => {
    const p = parseSlash("/compact");
    expect(p.cmd).toBe("compact");
    expect(p.arg).toBeUndefined();
  });
});

describe("formatUsageLine (AC-62c)", () => {
  it("formats with cached tokens when nonzero", () => {
    const line = formatUsageLine(1000, 200, 500, 5000);
    expect(line).toBe("(tokens: 1000 in (500 cached) / 200 out - session: 5000 total)");
  });

  it("omits the cached part when zero", () => {
    const line = formatUsageLine(300, 50, 0, 1200);
    expect(line).toBe("(tokens: 300 in / 50 out - session: 1200 total)");
  });
});
