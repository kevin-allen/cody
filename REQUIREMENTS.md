# cody — Requirements (MVP)

A terminal-based coding assistant built in TypeScript on the LangGraph agent
framework, with a swappable LLM backend (local via Ollama, or OpenAI /
Anthropic hosted models).

This document defines the **Minimum Viable Product**. It is intentionally small;
the roadmap at the end lists what we deliberately defer.

---

## Differentiator & design principles

cody's identity is **terminal-native + model-agnostic**:

- **Terminal-native (cooperative, not invasive).** cody behaves like a
  well-mannered CLI program. It never seizes the terminal — no alternate
  screen, no full-screen TUI, no mouse capture — so native scrollback, the OS's
  own copy/paste, and standard control keys keep working, including over SSH
  and tmux. Contrast with agentic TUIs that take over the screen and alter
  paste/selection behavior.
- **Model-agnostic.** The same agent runs against a local model (Ollama) or a
  hosted one (OpenAI / Anthropic) with a config change (§4.3) — not locked to a
  single vendor.
- **Composable / headless.** Because I/O is line-oriented, cody also runs
  non-interactively (piped / print mode) — the same design that powers
  unsupervised `auto` mode in a container (§4.4, §4.7).

**Fancy later means a GUI, not a TUI.** If cody ever grows a richer interface,
the plan is a proper standalone GUI — *not* an in-terminal full-screen TUI. The
terminal build stays deliberately simple (see §10).

---

... (unchanged sections omitted for brevity) ...

## 10. Roadmap (post-MVP, deferred)

- Codebase indexing / semantic search (RAG).
- Persistent cross-session memory (conversation persistence shipped: FR-40..42; only distilled memory remains on the roadmap).
- Optional **standalone GUI** (a separate app — the "fancy" path). Explicitly
  **not** an in-terminal full-screen TUI: the terminal build stays cooperative
  and simple (see Differentiator & design principles).
- Sub-agents / task delegation.
- Sandboxed / containerized command execution.
- Cost & token usage reporting; prompt caching for the hosted providers.
- Per-tool granular permission policies and allowlists.
- MCP tool integrations.  <!-- MARKED: moved to shipped -->


## FR-44 — MCP client and gating (shipped)

- Connect to external streamable-HTTP MCP servers declared in `config.mcp.servers` using `@langchain/mcp-adapters`.
- Server entries support `url`, `headers` (values may include `${ENV_VAR}` placeholders substituted from the process environment at resolve time), `insecureTls` (optional; relaxes TLS verification process-wide for internal CAs or dev servers), and an optional `tools` array to filter which tool names to expose.
- MCP tools are imported as LangChain `StructuredToolInterface`s and are namespaced as `serverName__toolName`.
- MCP tools are wrapped through the existing permission gate as a new `mcp` action. The policy presets apply: supervised = `ask`, auto = `allow`, readonly = `deny`. `permissions.mcp.allow` and `permissions.mcp.deny` are regex lists that control MCP tool allow/deny; the denylist wins over allowlist.
- The REPL's approval prompt supports the `[y/N/a]` always-allow option for MCP tools; choosing `a` adds a regex-anchored allow pattern for the tool name to `permissions.mcp.allow` in `cody.config.json`.
- Connection failures degrade to a stderr warning; the rest of cody remains usable.

<!-- end additions -->
