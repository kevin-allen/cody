# cody — Verification & Acceptance

Companion to [`REQUIREMENTS.md`](./REQUIREMENTS.md). Defines what "done and
correct" means for the MVP and how each criterion is checked. Requirement IDs
(FR-*) refer to the requirements document.

## Test strategy

- **Framework:** `vitest`.
- **Unit tests** — pure logic that must be right regardless of the LLM:
  config resolution, the provider factory's role→model mapping, path-escape
  guards, and the permission gate (policy resolution + denylist). These use no
  network and no real model.
- **Integration tests** — the agent graph with a **stub/fake `BaseChatModel`**
  that emits scripted tool calls, so the loop, tool dispatch, and permission
  gating are exercised deterministically without a provider.
- **Manual / smoke checks** — real-provider runs (OpenAI by default) for UX
  items that are impractical to assert automatically (streaming feel, prompt
  rendering). Listed explicitly below so they aren't skipped.
- **CI:** a GitHub Actions pipeline (`.github/workflows/ci.yml`) runs on every
  push / PR with three jobs:
  - **verify** (Node 20 & 22 matrix): `pnpm install --frozen-lockfile`, lint
    (ESLint), format check (Prettier), typecheck (`tsc`), unit + integration
    tests (`vitest`).
  - **pack-and-install**: `pnpm build` → `pnpm pack` → install the tarball into
    a clean temp dir → run `cody --help` to prove the published artifact
    launches (validates `bin`, shebang, and the `files` allowlist).
  - **docker**: build the image and run `cody --help` inside it.
  All three must pass to merge.

## Acceptance criteria

Each criterion notes how it is verified (**U**nit / **I**ntegration /
**M**anual).

| ID   | Criterion | How verified |
| ---- | --------- | ------------ |
| AC-1 | `pnpm build` and `pnpm test` pass; TypeScript strict mode, no errors. | CI |
| AC-2 | Switching the `agent` model between providers (e.g. OpenAI → Ollama) is a config-only change (no code edit); the graph runs unchanged against a stub model for each provider entry. | U + I |
| AC-3 | In `supervised` mode, a file edit or shell command is never executed without explicit approval. | U (permission gate) + I |
| AC-4 | Path-escape attempts (e.g. `../../etc/passwd`) are rejected by file tools in **every** mode, including `auto`. | U |
| AC-5 | A denied tool call (policy `deny` or a rejected `ask`) returns a "denied" result and the agent continues the conversation. | I |
| AC-6 | A shell command matching `permissions.shell.deny` is blocked even in `auto` mode. | U |
| AC-7 | `readonly` mode refuses every write / edit / shell action. | U |
| AC-8 | Selecting a model that lacks tool-calling fails at startup with a clear message (FR-17). | U |
| AC-9 | On startup, cody prints a banner naming the active permission mode; `auto` is never the default (FR-23). | U + M |
| AC-10 | The packed npm tarball installs into a clean environment and `cody --help` runs (FR-31). | CI (pack-and-install) |
| AC-11 | The Docker image builds and `cody --help` runs inside it (FR-32). | CI (docker) |

## Manual smoke checklist (per release)

Run against the default OpenAI provider from a scratch working directory:

1. Start cody; confirm the mode banner shows `supervised`.
2. Ask a question requiring a file read → answer streams; no prompt for the read.
3. Ask for an edit → a **diff preview** is shown and approval is requested;
   approving writes the file, denying does not and the agent continues.
4. Ask to run a command → the exact command is shown and approval requested.
5. `/clear` resets the conversation; `/exit` quits cleanly; Ctrl-C cancels the
   current turn without killing the session.
6. Start with `--auto` in a throwaway/container context → banner shows `auto`,
   no prompts appear, and a denylisted command is still blocked.

## Definition of done (MVP)

- All acceptance criteria AC-1…AC-11 pass (CI green, including pack-and-install
  and docker jobs).
- Manual smoke checklist completed on the default provider.
- README documents install, config (model catalog + roles + permissions), and
  the three providers.
