# cody — Architecture

Companion to [`REQUIREMENTS.md`](./REQUIREMENTS.md). This document describes the
runtime structure and module layout. Requirement IDs (FR-*, AC-*) refer to that
document.

## Overview

```
              ┌────────────────────────────────────────┐
   terminal   │                CLI / REPL                │  readline loop,
   (user) ───▶│  render output, stream tokens, prompts   │  approval prompts
              └───────────────┬──────────────────────────┘
                              │ user message
                              ▼
              ┌────────────────────────────────────────┐
              │           LangGraph agent graph          │
              │   model node  ⇄  tool node (loop)        │
              └───────┬───────────────────┬──────────────┘
                      │                   │
             getModel(role)           tool registry
          (role→model def→client)         │
                      │                   │
      ┌───────────────┼────────┐   ┌──────┴───────────────────────┐
      ▼               ▼        ▼   ▼        ▼        ▼      ▼
  ChatOpenAI    ChatAnthropic ChatOllama  read  write/edit  run_shell  grep/glob
   (gpt-4o,       (opus-4-8)   (local)    (auto)  (approval) (approval) (auto)
    default)
```

## Layers

- **CLI / REPL** (`ui/`) — the terminal loop: reads user input, streams
  assistant tokens, renders tool calls/results, and drives approval prompts
  (§4.5). It is the only layer that talks to stdin/stdout, and it is
  **cooperative** — no alternate screen, no mouse capture, appends to
  scrollback (FR-34–37). The same rendering path backs headless / print mode
  (FR-38), so interactive and `auto`/piped runs share one code path.
- **Agent graph** (`agent/`) — the LangGraph reason→act→observe loop. Depends
  only on the LangChain `BaseChatModel` tool-calling interface and the tool
  registry — never on a concrete provider (FR-2).
- **Provider factory** (`providers/`) — `getModel(role)` resolves a task role →
  named model definition → configured `BaseChatModel` (FR-13–15). This is the
  single seam where provider/model choice lives; the graph asks by role.
- **Tool layer** (`tools/`) — the tool registry plus the permission gate.
  Read/search tools run per policy; write/edit/shell pass through the
  permission layer (§4.4) before executing.

## Key seams (why the design is flexible)

- **Model choice is role-indirected.** The graph calls `getModel("agent")`;
  adding a new task with its own model is a config change (`roles` entry), not
  a code change. See FR-13–15.
- **Permissions are policy-driven.** Tools call into `permissions` to resolve
  `allow` / `ask` / `deny` from the configured mode; the graph and tools don't
  hard-code approval behavior. See §4.4.
- **Provider-agnostic graph.** Swapping OpenAI ↔ Anthropic ↔ Ollama touches
  only the factory and config (AC-2).
- **deepagents-compatible.** The tool registry and provider factory consume
  plain LangChain tools + a `BaseChatModel`, so adopting LangGraph's
  `deepagents` scaffold later (planning, sub-agents) is additive — see
  `REQUIREMENTS.md` §10.

## Module layout

```
src/
  index.ts           # entrypoint: parse flags, load config, start REPL
  config.ts          # config resolution (defaults → file → env → flags)
  providers/
    factory.ts       # getModel(role) -> BaseChatModel (role → model def → client)
  agent/
    graph.ts         # LangGraph definition (model + tool nodes, loop)
    state.ts         # graph state / message schema
  tools/
    index.ts         # tool registry
    fs.ts            # read_file, list_dir, glob, grep, write_file, edit_file
    shell.ts         # run_shell
    permissions.ts   # policy resolution + approval gating + diff rendering
  ui/
    repl.ts          # readline loop, streaming render, slash commands
    render.ts        # formatting for messages/tools/diffs
```
