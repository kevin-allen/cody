import { describe, it, expect } from "vitest";
import { PasteFilter, restorePaste, PASTE_START, PASTE_END, PASTE_NEWLINE } from "./paste.js";

describe("PasteFilter", () => {
  it("passes normal typing through unchanged", () => {
    expect(new PasteFilter().feed("hello world\n")).toBe("hello world\n");
  });

  it("strips markers and replaces newlines inside a paste", () => {
    const out = new PasteFilter().feed(`${PASTE_START}line1\nline2\nline3${PASTE_END}`);
    expect(out).toBe(`line1${PASTE_NEWLINE}line2${PASTE_NEWLINE}line3`);
    expect(out).not.toContain("\n");
  });

  it("preserves text around a paste", () => {
    const out = new PasteFilter().feed(`a${PASTE_START}x\ny${PASTE_END}b\n`);
    expect(out).toBe(`ax${PASTE_NEWLINE}yb\n`);
  });

  it("handles a start marker split across two chunks", () => {
    const f = new PasteFilter();
    // Split right in the middle of the 6-byte start marker.
    const mid = PASTE_START.slice(0, 3);
    const rest = PASTE_START.slice(3);
    let out = f.feed(`hi${mid}`);
    out += f.feed(`${rest}a\nb${PASTE_END}`);
    expect(out).toBe(`hia${PASTE_NEWLINE}b`);
  });

  it("handles paste content arriving across chunks", () => {
    const f = new PasteFilter();
    let out = f.feed(`${PASTE_START}first\n`);
    out += f.feed(`second${PASTE_END}done`);
    expect(out).toBe(`first${PASTE_NEWLINE}seconddone`);
  });
});

describe("restorePaste", () => {
  it("turns placeholders back into newlines", () => {
    expect(restorePaste(`a${PASTE_NEWLINE}b${PASTE_NEWLINE}c`)).toBe("a\nb\nc");
  });

  it("is a no-op for normal input", () => {
    expect(restorePaste("just text")).toBe("just text");
  });

  it("round-trips a pasted block", () => {
    const filtered = new PasteFilter().feed(`${PASTE_START}def f():\n    return 1${PASTE_END}`);
    expect(restorePaste(filtered)).toBe("def f():\n    return 1");
  });
});
