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

## 1. Goals

- Give the user an interactive terminal assistant that can understand a
  codebase, propose changes, edit files, and run commands — with the user in
  control of anything destructive.
- Keep the LLM provider swappable so the same agent runs against a local model
  or a hosted one with only a config change.
- Establish a clean, extensible architecture (agent graph + tool layer +
  provider layer) that we can grow over time.

## 2. Non-goals (for the MVP)

Explicitly out of scope for v1 — revisit later (see §10):

- No IDE / editor integration, no GUI, no web UI.
- No multi-agent orchestration or sub-agents.
- No RAG / vector store / semantic codebase indexing (rely on file reads +
  grep/glob for now).
- No persistent long-term memory across sessions (session-scoped only).
- No MCP servers or external tool integrations.
- No autonomous / unattended mode — a human is always at the terminal.

## 3. Tech stack

| Concern            | Choice                                                        |
| ------------------ | ------------------------------------------------------------- |
| Language           | TypeScript (strict mode), Node.js ≥ 20                        |
| Package manager    | pnpm                                                          |
| Agent framework    | LangGraph (`@langchain/langgraph`)                            |
| LLM abstraction    | LangChain chat models (`@langchain/core`)                     |
| OpenAI provider    | `@langchain/openai` — **default provider**, default model `gpt-4o` |
| Anthropic provider | `@langchain/anthropic` — default model `claude-opus-4-8`      |
| Local provider     | `@langchain/ollama` (talks to a local Ollama server)          |
| Env loading        | `dotenv` (loads `.env` at startup)                            |
| CLI                | Node `readline` for the REPL loop — cooperative, no full-screen TUI (a standalone GUI could come later) |
| Config             | Env vars + a `cody.config.json` (or `.codyrc`) file           |
| Testing            | `vitest`                                                      |
| Lint / format      | ESLint + Prettier                                             |

## 4. Functional requirements

### 4.1 Agent loop (LangGraph)

- FR-1: cody runs a LangGraph agent graph implementing the standard
  reason → act → observe loop (model node ↔ tool node, looping until the model
  emits a final answer with no tool calls).
- FR-2: The graph is **provider-agnostic** — it depends only on the LangChain
  `BaseChatModel` tool-calling interface, never on a concrete provider.
- FR-3: Conversation state (message history, including tool calls and results)
  is held for the duration of a session using LangGraph state; a checkpointer
  (in-memory for MVP) preserves state across turns within a run.
- FR-4: Streaming — assistant text is streamed token-by-token to the terminal
  as it is produced.

### 4.2 Tools

The agent is given the following tools. Read tools run without prompting; write
and execute tools require approval (see §4.4).

- FR-5 `read_file(path)` — read a file's contents.
- FR-6 `list_dir(path)` — list a directory.
- FR-7 `glob(pattern)` — find files by glob pattern.
- FR-8 `grep(pattern, path?)` — search file contents by regex.
- FR-9 `write_file(path, content)` — create or overwrite a file. **Requires
  approval.** Shows a diff/preview before applying.
- FR-10 `edit_file(path, old, new)` — targeted string replacement in a file.
  **Requires approval.** Shows a diff before applying.
- FR-11 `run_shell(command)` — execute a shell command in the working
  directory and return combined stdout/stderr + exit code. **Requires
  approval.**
- FR-12 All tools operate relative to a single **working directory** (the repo
  cody was launched in). File tools must reject paths that escape the working
  directory (resolve to canonical path, verify it stays within root) unless the
  user has explicitly allowed it.

### 4.3 Providers & models (swappable LLM)

Models are configured as a **named catalog** plus **role assignments**, not a
single global model — so different tasks can use different models without any
change to the agent graph.

- FR-13 (model catalog): The config defines a `models` map of **named model
  definitions**, each a bundle of `{ provider, model, ...settings }` where
  `provider` is `openai` | `anthropic` | `ollama`. Settings include model id,
  temperature/effort, `maxTokens`, and provider-specific fields (e.g. `baseUrl`
  for Ollama). At least one entry named `default` is required.
- FR-14 (role assignments): The config defines a `roles` map from a **task
  role** (free-form string) to a model name in the catalog. The agent requests
  a model **by role**, never by provider/name. An unknown or unassigned role
  falls back to the model named `default`, so new roles never break config.
  - MVP uses exactly one role, `agent` (the main reasoning + tool-calling
    loop). Future roles (e.g. `summarize`, `title`, `plan`) are additive —
    a one-line `roles` entry pointing at an existing model.
- FR-15 (factory / seam): A single factory exposes `getModel(role)` → resolves
  role → model definition → a configured `BaseChatModel`. Adding a provider
  means adding one case in the factory and nothing in the agent graph or tools.
- FR-16 (credentials): Credentials come from environment variables, loaded
  from a local `.env` file (via `dotenv`) at startup: `OPENAI_API_KEY`
  (required for the default provider), `ANTHROPIC_API_KEY`. Ollama needs none
  (local server URL, default `http://localhost:11434`). **API keys live only in
  `.env`, never in the model catalog** (which may be committed) — the factory
  resolves the key from env per provider at model-build time. `.env` MUST be
  git-ignored; a committed `.env.example` documents the expected variables
  without real values.
- FR-17 (capability check): Every model used **must support tool/function
  calling** — cody validates the `agent`-role model at startup and fails with a
  clear message if it (e.g. a small local model) does not.
- FR-39 (proxy support): cody routes hosted-provider HTTP through the standard
  proxy environment variables (`HTTP(S)_PROXY`) when set, honoring `NO_PROXY`
  so local providers (Ollama on localhost) bypass the proxy. Node's built-in
  `fetch` — used by the provider SDKs — ignores these vars by default, so cody
  installs a proxy-aware dispatcher at startup. (Needed on corporate networks,
  e.g. the DKFZ proxy.)

Reference default models per provider (used when authoring catalog entries):

| Provider           | Suggested model                     |
| ------------------ | ----------------------------------- |
| **openai** (default) | `gpt-4o` (or `gpt-4o-mini` to save cost) |
| anthropic          | `claude-opus-4-8`                   |
| ollama             | `qwen2.5-coder` (or user set)       |

### 4.4 Permissions / safety

Permission behavior is **configured**, not hard-coded, via a `permissions`
block (§4.6). cody runs interactively with approval prompts by default, but can
run fully autonomously in a trusted sandbox (e.g. a Docker container) for
unsupervised use.

- FR-18 (per-action policy): Each tool category has a policy of `allow` (run
  without prompting), `ask` (pause and prompt for `[y/N]`), or `deny` (refuse
  and report back to the agent). Categories: `read` (read_file / list_dir /
  glob / grep), `write` (write_file), `edit` (edit_file), `shell` (run_shell).
- FR-19 (modes / presets): A `mode` selects a preset of per-action policies;
  an optional `overrides` map adjusts individual actions on top of it:
  - `supervised` (default): read = allow; write / edit / shell = ask.
  - `auto` (unsupervised — for sandboxes / Docker): all = allow.
  - `readonly`: read = allow; write / edit / shell = deny.
- FR-20 (approval UX): When an action resolves to `ask`, cody pauses the agent
  and prompts. File write/edit prompts show a **diff preview**; shell prompts
  show the exact command to be run.
- FR-21 (denied → recover): An action that is `deny`, or that the user rejects
  at an `ask` prompt, returns a "denied" result to the agent so it can adapt,
  rather than crashing the session. After a rejection the user may optionally
  type a one-line reason; it is appended to the denial result ("[denied by
  user — reason: …]") — the model's only signal for *why*, without which it
  tends to re-propose the same action.
- FR-22 (guards apply in every mode, including `auto`):
  - Working-directory confinement (FR-12) is **always** enforced, regardless
    of mode.
  - An optional shell **denylist** (regex patterns) blocks matching commands
    even under `allow` / `auto`; a denylist match always wins over the policy.
- FR-22a (shell allowlist): an optional shell **allowlist** (regex patterns)
  auto-approves matching commands that would otherwise `ask` (e.g. `^git\s+status`
  in `supervised` mode). It only skips the prompt: the denylist still wins over
  it, and it never upgrades a `deny` policy (so `readonly` stays readonly).
- FR-22b (always allow): the interactive shell approval prompt is `[y/N/a]`;
  answering `a`/`always` approves the command AND appends it — regex-escaped
  and `^…$`-anchored, so exactly that command — to `permissions.shell.allow`
  in the project's `cody.config.json` (created if absent, other fields
  preserved). The addition takes effect immediately in the running session.
  If the file can't be written, the command is allowed for the session only,
  with a warning.
- FR-23 (explicit + visible): `auto` mode must be enabled **explicitly** (via
  `permissions.mode: "auto"`, or `--auto` / `CODY_MODE=auto`) — it is never the
  default. On startup cody prints a banner stating the active mode, so an
  unsupervised session is never a surprise.

### 4.5 Terminal UX

Implements the **terminal-native** principle above: cooperative, never
invasive.

- FR-24: cody launches into an interactive REPL: the user types a request, cody
  responds (streaming), possibly invoking tools with approval prompts, and
  loops.
- FR-25: Tool activity is visible as it happens: each completed tool run is
  echoed as a dim `→ tool args` line (with a `[denied]`/`[blocked]`/`[error]`
  marker when it failed), so a working agent is distinguishable from a hung
  one. Clear visual distinction between assistant text, tool calls, tool
  results, and approval prompts.
- FR-26: Commands: `/exit` (quit), `/clear` (reset conversation), `/help`
  (list commands). More can be added later.
- FR-27: Graceful handling of errors (network, provider, tool failures)
  without crashing the session. A turn that errors or is cancelled mid
  tool-call must not corrupt the conversation: cody repairs the thread's
  dangling tool calls (synthetic "[interrupted]" results) so the next turn
  still works.
- FR-27a (never drop input): a line typed while a turn is streaming is queued
  and dispatched in order when the turn ends — not silently discarded. Answers
  to a pending approval prompt take precedence and are consumed as answers.
- FR-34 (cooperative rendering): cody **never** uses the alternate screen
  buffer, a full-screen layout/redraw loop, or mouse capture. All output is
  appended to normal scrollback; cody leaves the terminal as it found it on
  exit. Text streams by appending; in-place progress is limited to the current
  line (`\r`).
- FR-35 (native input & paste): rely on the terminal's own selection / copy /
  paste — cody does not capture the mouse. Support **bracketed paste** so a
  multi-line paste is captured as one input instead of submitting at the first
  newline. Brief, scoped single-key reads are permitted for prompts (e.g. a
  one-keystroke `[y/N]`); cody must restore terminal state immediately after.
- FR-36 (control keys): preserve standard semantics — `Ctrl-C` cancels the
  current turn (not the process), `Ctrl-D` on an empty line exits, `Ctrl-Z`
  suspends.
- FR-37 (color & TTY): emit ANSI color only when stdout is a TTY; honor
  `NO_COLOR`; degrade cleanly on dumb terminals and when output is piped or
  redirected.
- FR-38 (headless / print mode): a non-interactive mode — `cody -p "<task>"`
  or piped stdin — runs to completion with plain (or structured) line output
  and meaningful exit codes, no prompts. This shares the code path with `auto`
  mode (§4.4) and is the intended entrypoint for scripts and the Docker image
  (§4.7).

### 4.6 Configuration

- FR-28: Config resolution order (later overrides earlier): built-in defaults →
  `cody.config.json` in the working directory → environment variables →
  command-line flags.
- FR-29: Config surface for MVP — a model catalog, role assignments, and a few
  top-level settings. The MVP only needs the `default` model and the `agent`
  role; the commented entries show how future multi-model use slots in without
  code changes:
  ```jsonc
  {
    "models": {
      "default": { "provider": "openai", "model": "gpt-4o", "temperature": 0 }
      // "fast":  { "provider": "openai",    "model": "gpt-4o-mini" },
      // "deep":  { "provider": "anthropic", "model": "claude-opus-4-8" },
      // "local": { "provider": "ollama",    "model": "qwen2.5-coder",
      //            "baseUrl": "http://localhost:11434" }
    },
    "roles": {
      "agent": "default"        // main reasoning + tool-calling loop
      // "summarize": "fast",   // additive later — no code change
      // "plan":      "deep"
    },
    "permissions": {
      "mode": "supervised",     // supervised (default) | auto | readonly
      "overrides": {},          // optional: read|write|edit|shell -> allow|ask|deny
      "shell": {
        "deny": ["rm\\s+-rf\\s+/", "git\\s+push", ":\\(\\)\\s*\\{"], // blocks in every mode
        "allow": ["^git\\s+status", "^pnpm\\s+test"] // optional: skips the ask prompt
      }
    },
    "limits": {
      "recursionLimit": 200 // max agent super-steps per turn (~2 per tool round);
                            // a runaway-loop cost backstop, not a task budget
    }
  }
  ```
- FR-30 (quick override): a flag/env var can repoint a role at another catalog
  entry without editing the file, e.g. `--model deep` or `CODY_AGENT_MODEL=deep`
  (resolved against the `models` catalog; overrides the `agent` role).

### 4.7 Packaging & distribution

- FR-31 (npm CLI): cody is published as an npm package exposing a `cody`
  binary (`bin` → `dist/index.js`, with a `#!/usr/bin/env node` shebang).
  Installable globally (`pnpm add -g` / `npm i -g`) or runnable via `npx`. The
  published tarball ships only built output + metadata (a `files` allowlist).
- FR-32 (Docker image): a `Dockerfile` (+ `.dockerignore`) builds a runnable
  image with cody as the entrypoint — the intended way to run `auto` /
  unsupervised mode with OS-level isolation (§4.4, §7). Config and `.env` are
  supplied at run time (bind mount / `--env-file`), never baked into the image.
- FR-33 (CI): a GitHub Actions pipeline runs on every push / PR with three
  jobs (detailed in `VERIFICATION.md`): **verify** (Node 20 & 22: install with
  frozen lockfile, lint, format check, typecheck, tests), **pack-and-install**
  (build → `pnpm pack` → install the tarball in a clean dir → run `cody --help`),
  and **docker** (build the image and run `cody --help` inside it).

## 5. Architecture

The runtime structure and module layout are maintained in a separate document:
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

## 6. Verification & acceptance

Acceptance criteria, the test strategy, and the manual smoke checklist are
maintained in a separate document: [`VERIFICATION.md`](./VERIFICATION.md).

## 7. Assumptions

- The user has Node ≥ 20 and pnpm installed; for local models, a running
  Ollama server with a tool-calling-capable model pulled.
- API keys for hosted providers are supplied via environment variables.
- cody is run from within the project directory it should operate on.
- In `auto` (unsupervised) mode, cody performs no OS-level sandboxing itself —
  process/filesystem/network isolation is the user's responsibility (e.g.
  running cody inside a Docker container). The in-app guards (workdir
  confinement, shell denylist) are defense-in-depth, not a substitute for it.

## 8. Risks / open questions

- Local (Ollama) model tool-calling quality varies a lot by model — smaller
  models may loop or produce malformed tool calls. Mitigate with the FR-17
  capability check and a curated default model.
- LangGraph's TypeScript API surface evolves; pin versions.
- Shell execution is inherently dangerous; the approval gate (FR-19–22) is the
  primary control for MVP. Sandboxing is deferred.

## 9. MVP milestones

1. **Scaffold + CI** — pnpm project, TS strict, lint/format/test; entrypoint
   with `bin` + shebang; `package.json` `files` allowlist; `.env.example`;
   GitHub Actions verify + pack-and-install jobs green from day one.
2. **Provider layer** — factory + all three providers, config resolution,
   capability check.
3. **Tools** — read/search tools, then write/edit/run with the permission gate
   and diff rendering.
4. **Agent graph** — LangGraph model↔tool loop wired to the tool registry.
5. **REPL** — streaming output, approval prompts, slash commands, error/Ctrl-C
   handling.
6. **Polish & package** — README, `Dockerfile` + `.dockerignore` + docker CI
   job, full acceptance suite (AC-1…AC-11).

## 10. Roadmap (post-MVP, deferred)

- Codebase indexing / semantic search (RAG).
- Persistent cross-session memory.
- Optional **standalone GUI** (a separate app — the "fancy" path). Explicitly
  **not** an in-terminal full-screen TUI: the terminal build stays cooperative
  and simple (see Differentiator & design principles).
- Sub-agents / task delegation.
- MCP tool integrations.
- Sandboxed / containerized command execution.
- Cost & token usage reporting; prompt caching for the hosted providers.
- Per-tool granular permission policies and allowlists.
```
