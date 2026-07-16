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

## FR-62 — Token usage: accurate accounting and a ≥50% cut in billed input

**Motivation (measured).** Implementing FR-15's side-channel fix (commit
37c3ef2) in one REPL turn, cody reported `5,104,399 in / 8,797 out`; the
DeepSeek dashboard recorded **2,500,000 in / 4,833 out** for the same work —
cody over-reports by ~2x, and even the true 2.5M input is disproportionate to
a ~130-line diff. Competitive agents spend materially less for equivalent
work; target is **at least a 50% reduction in billed input tokens** on
comparable tasks, plus trustworthy reporting.

- **AC-62a (accounting):** usage reported by cody matches the provider
  dashboard within a few percent. Investigate the ~2x double-count in
  `streamAgentEvents`' per-chunk `usage_metadata` accumulation (usage likely
  counted on both partial and final chunks of the same call). The session
  totals and the auto-compact trigger consume this same counter, so the fix
  gates the ACs below.
- **AC-62b (compact metric):** auto-compaction triggers on the *current
  context size* (the last model call's input tokens), not the cumulative sum
  across all calls in a turn. Today a 30-round turn with a 25k context "exceeds"
  a 150k threshold and compacts needlessly, while a single-call 140k-context
  turn never triggers.
- **AC-62c (cache visibility):** the usage line splits cached from fresh input
  on providers that report it (DeepSeek `prompt_cache_hit_tokens`, Anthropic
  `cache_read_input_tokens`, OpenAI `cached_tokens`), e.g.
  `(tokens: 2.5M in (2.1M cached) / 4.8k out)`. Cached input bills at ~1/10th;
  the current single number wildly overstates cost.
- **AC-62d (the 50% cut):** a comparable multi-file fix-plus-tests turn
  consumes ≤50% of the FR-62 baseline's billed input tokens. Levers, in
  expected order of impact: evict or truncate stale tool results mid-turn
  (verbose test output and full file reads are re-billed on every subsequent
  round); delegate broad exploration to `run_subagent` so large reads never
  enter the parent transcript (system-prompt discipline #7 exists — verify it
  fires in practice); compact mid-turn when AC-62b's metric crosses the
  threshold instead of only at turn boundaries.
- Baseline for AC-62d: the 37c3ef2 turn (2.5M billed input, DeepSeek
  deepseek-v4-pro, supervised mode, 238-test suite).

<!-- end additions -->
