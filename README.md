# cody

A terminal-native, model-agnostic coding assistant, built in TypeScript on
[LangGraph](https://github.com/langchain-ai/langgraphjs). It runs in your
terminal, reads and searches your codebase, edits files, and runs commands —
with you approving anything that changes your machine — against a local model
(Ollama) or a hosted one (OpenAI / Anthropic), chosen by config.

**Design principles** (see [`REQUIREMENTS.md`](./REQUIREMENTS.md)):

- **Terminal-native** — cody never takes over your terminal: no alternate
  screen, no full-screen TUI, no mouse capture. Native scrollback, your
  terminal's own copy/paste, and standard control keys keep working, including
  over SSH and tmux. Multi-line pastes are captured as one input (bracketed
  paste).
- **Model-agnostic** — the same agent runs against OpenAI, Anthropic, or a
  local Ollama model; switching is a config change.
- **Composable** — line-oriented I/O means cody also runs headless (`cody run`,
  piping) and unsupervised in a container.

## Install

Requires Node.js ≥ 20.

```bash
# from source
git clone https://github.com/kevin-allen/cody && cd cody
corepack enable                 # provides pnpm
pnpm install
pnpm build
node dist/index.js --help

# or, once published, as a global CLI
pnpm add -g cody                # then: cody --help
```

## Quick start

```bash
cp .env.example .env            # then edit: set OPENAI_API_KEY
cody                            # start the interactive session
```

`.env` is git-ignored. cody loads it at startup.

## Configuration

cody resolves configuration in this order (later overrides earlier): built-in
defaults → `cody.config.json` in the working directory → environment variables
→ command-line flags.

```jsonc
// cody.config.json
{
  "models": {
    "default": { "provider": "openai", "model": "gpt-4o", "temperature": 0 }
    // "fast":  { "provider": "openai",    "model": "gpt-4o-mini" },
    // "deep":  { "provider": "anthropic", "model": "claude-opus-4-8" },
    // "local": { "provider": "ollama",    "model": "qwen2.5-coder" }
  },
  "roles": {
    "agent": "default", // which catalog model the agent uses
    "title": "nano" // optional: a cheaper model for auto-generated session titles
  },
  "permissions": {
    "mode": "supervised", // supervised (default) | auto | readonly
    "overrides": {}, // read|write|edit|shell -> allow|ask|deny
    "shell": {
      "deny": ["rm\\s+-rf\\s+/", "git\\s+push"], // blocked in every mode
      "allow": ["^git\\s+status", "^pnpm\\s+test"] // auto-approved (skips the ask)
    }
  },
  "sessions": {
    "enabled": true, // session persistence enabled by default; path is optional
    "path": "sessions.sqlite" // optional: a project-local path for session state
  },
  "limits": {
    "recursionLimit": 200 // max agent steps per turn (~2 per tool call);
                          // backstop against runaway loops, not a task budget
  }
}
```

- **Models are a named catalog + role assignments** — define a model once, point
  any role at it. Adding "use a cheaper model for X later" is a one-line change.
- **API keys live only in `.env`**, never in the config file: `OPENAI_API_KEY`
  (default provider), `ANTHROPIC_API_KEY`. Ollama needs none
  (`OLLAMA_BASE_URL`, default `http://localhost:11434`).
- Quick overrides: `--model deep` / `CODY_AGENT_MODEL=deep`;
  `--mode auto` / `--auto`, `--readonly`, `CODY_MODE=auto`.

### Permissions

Sessions: sessions get an automatic title generated in the background by the `title` role model (best-effort — very short-lived sessions may keep the first-message preview instead). Use `/title <text>` in the REPL to set a manual title. Run `cody sessions prune` to trim old checkpoints, keeping the latest per session.


| Mode                   | read  | write / edit / shell |
| ---------------------- | ----- | -------------------- |
| `supervised` (default) | allow | ask (`[y/N]`)        |
| `auto` (unsupervised)  | allow | allow                |
| `readonly`             | allow | deny                 |

Writes and edits show a diff before asking; shell commands show the exact
command. After a rejection you can optionally type a one-line reason for the
agent — it lands in the tool result, so the model adapts instead of retrying
the same thing. Anything you type while a turn is still streaming is queued
and runs when the turn ends. While the agent works, each tool run is echoed
as a dim `→ tool args` line, so you can see what it is doing between replies. A shell **denylist** blocks matching commands in *every* mode,
including `auto`. A shell **allowlist** auto-approves matching commands that
would otherwise ask (handy for `git status`, test runs, …) — the denylist
still wins over it, and it never overrides `readonly`. At a shell approval
prompt (`[y/N/a]`), answer `a` to approve **and** allowlist exactly that
command in `cody.config.json`, effective immediately — so the list grows from
real usage instead of hand-edited regexes. All file access is confined to the
working directory.

Use `auto` only in a sandbox you trust (e.g. a container) — cody does no
OS-level isolation itself.

### MCP servers

cody can connect to external MCP (Model Context Protocol) servers and import their tools as LangChain tools. Configure them in `cody.config.json` under an `mcp` block. Example:

```jsonc
{
  "mcp": {
    "servers": {
      "math": {
        "url": "https://math.example.com/mcp",
        "headers": { "Authorization": "Bearer ${MATH_TOKEN}" },
        "insecureTls": false,
        "tools": ["add", "mul"]
      }
    }
  }
}
```

- Headers support `${VAR}` substitution from the process environment at resolve time; keep secrets in your local `.env` (git-ignored) per the config model.
- `insecureTls: true` disables TLS verification process-wide (use only for internal CAs / dev servers) — this is global for the process and disables verification on outbound requests.
- `tools` is an optional allowlist: only MCP tools with the unprefixed name in this array are kept for that server.

MCP tools are imported namespaced as `serverName__toolName` (two underscores) and are wrapped by the same permission gate as built-in tools under a new `mcp` action: supervised mode prompts (`ask`), `auto` allows, and `readonly` denies. Use `permissions.mcp.allow` and `permissions.mcp.deny` (regex lists) to control MCP tools; the REPL's `[y/N/a]` always-allow option applies to tool *names* — it will add a regex-anchored allow pattern for the tool name to `permissions.mcp.allow` in `cody.config.json`. The `cody tools` command also lists connected MCP tools.

## Usage

```
cody                     Start the interactive session (REPL).
cody run "<task>"        Run one turn headlessly and print the result.
cody config              Print the resolved configuration.
cody model [role]        Show the model a role resolves to.
cody tools               List the tools and their permission policy.
cody --help | --version
cody --continue         Start or resume the most recent REPL session
cody --resume <id|index|substring>      Resume a specific session by id, index, or a unique id substring
cody sessions                     List known sessions (headless)
cody sessions prune               Prune old checkpoints across sessions
```

In the REPL: type a request; `/help`, `/clear`, `/sessions`, `/resume <n|id>`, `/title`, `/exit` (or Ctrl-D). Ctrl-C
cancels the current turn.

## Docker

Runs cody unsupervised in an isolated container (the intended way to use
`auto` mode). Mount your project and pass credentials at run time:

```bash
docker build -t cody .
docker run -it --rm -v "$PWD":/workspace --env-file .env cody run --auto "fix the failing test"
```

Behind a corporate proxy, forward it to the build:
`docker build --build-arg HTTPS_PROXY="$HTTPS_PROXY" -t cody .`

## Networks / proxies

cody honors the standard `HTTP(S)_PROXY` / `NO_PROXY` environment variables for
hosted-provider traffic (Node's `fetch` ignores them by default), so it works
behind a corporate proxy while local providers on `NO_PROXY` hosts bypass it.

## Develop

```bash
pnpm dev --help        # run from source (tsx)
pnpm test              # unit + integration tests (vitest)
pnpm lint              # eslint
pnpm format:check      # prettier
pnpm typecheck         # tsc --noEmit
pnpm build             # compile to dist/
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`VERIFICATION.md`](./VERIFICATION.md).
