import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSessionStore } from "./sessions.js";

describe("SessionStore", () => {
  let wd = "";
  afterEach(() => {
    if (wd) {
      try {
        rmSync(wd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    wd = "";
  });

  it("creates directory and DB file on open", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "data", "sessions.db");
    const store = openSessionStore(dbPath);
    expect(store).toBeDefined();
    store.close();
  });

  it("register and list ordering and latest/has", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const a = store.newSessionId();
    const b = store.newSessionId();
    store.register(a);
    store.register(b);
    const list = store.list();
    expect(list.length).toBe(2);
    // newest-first by updatedAt -> b should be newest because registered later
    const first = list[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("missing first");
    expect(first.id).toBe(b);
    const lat = store.latest();
    expect(lat).toBeDefined();
    if (!lat) throw new Error("missing latest");
    expect(lat).toBe(b);
    expect(store.has(a)).toBe(true);
    expect(store.has("nope")).toBe(false);
    store.close();
  });

  it("touch sets preview once and accumulates tokens", () => {
    wd = mkdtempSync(join(tmpdir(), "cody-sess-"));
    const dbPath = join(wd, "sessions.db");
    const store = openSessionStore(dbPath);
    const id = store.newSessionId();
    store.register(id);
    store.touch(id, "first\nline\nmore", { inputTokens: 1, outputTokens: 2 });
    const one = store.list().find((r) => r.id === id);
    expect(one).toBeDefined();
    if (!one) throw new Error("missing session");
    expect(one.preview).toBe("first line more");
    expect(one.inputTokens).toBe(1);
    expect(one.outputTokens).toBe(2);
    // second touch with different preview should not overwrite preview
    store.touch(id, "ignored preview", { inputTokens: 3, outputTokens: 4 });
    const two = store.list().find((r) => r.id === id);
    expect(two).toBeDefined();
    if (!two) throw new Error("missing session");
    expect(two.preview).toBe("first line more");
    expect(two.inputTokens).toBe(4);
    expect(two.outputTokens).toBe(6);
    store.close();
  });
});
