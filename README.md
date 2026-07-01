# cody

A terminal-native, model-agnostic coding assistant, built in TypeScript on
LangGraph. It runs in your terminal, edits files and runs commands (with your
approval), and works against a local model (Ollama) or a hosted one (OpenAI /
Anthropic) — chosen by config.

See [`REQUIREMENTS.md`](./REQUIREMENTS.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md),
and [`VERIFICATION.md`](./VERIFICATION.md) for the design.

> Status: early scaffold (milestone 1). The interactive agent is not wired up
> yet — `cody --help` / `--version` work today.

## Develop

Requires Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm dev --help        # run from source
pnpm build && pnpm start --help
pnpm test              # unit + integration tests
pnpm lint              # eslint
pnpm format:check      # prettier
pnpm typecheck         # tsc --noEmit
```

Copy `.env.example` to `.env` and set `OPENAI_API_KEY` (default provider).
`.env` is git-ignored.
