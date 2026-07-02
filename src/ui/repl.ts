import { createInterface } from "node:readline";
import type { Transform } from "node:stream";
import { MemorySaver } from "@langchain/langgraph";
import type { Config } from "../config.js";
import {
  modelDefForRole,
  commandToAllowPattern,
  withShellAllowPattern,
  saveShellAllowPattern,
} from "../config.js";
import { getModel, assertToolCapable } from "../providers/factory.js";
import { createTools } from "../tools/index.js";
import type { ApprovalRequest, ConfirmResult } from "../tools/index.js";
import { createAgent, streamAgentText, repairDanglingToolCalls } from "../agent/graph.js";
import type { UsageTotals } from "../agent/graph.js";
import {
  makePalette,
  colorEnabled,
  banner,
  formatApproval,
  isAffirmative,
  parseApprovalAnswer,
} from "./render.js";
import type { Palette } from "./render.js";
import {
  createPasteFilterStream,
  restorePaste,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from "./paste.js";

export type SlashCommand = "exit" | "clear" | "help" | "usage" | "unknown";

/** Parse a slash command (pure — for testing). */
export function parseSlash(input: string): SlashCommand {
  const cmd = input.trim().slice(1).trim().toLowerCase();
  if (cmd === "exit" || cmd === "quit") return "exit";
  if (cmd === "clear") return "clear";
  if (cmd === "help") return "help";
  if (cmd === "usage") return "usage";
  return "unknown";
}

/** Whether a bare line is an attempt to quit without the slash (exit / quit). */
export function isBareQuit(input: string): boolean {
  return /^(exit|quit)$/i.test(input.trim());
}

function helpText(p: Palette): string {
  return [
    `${p.bold("/help")}   show this help`,
    `${p.bold("/clear")}  start a fresh conversation`,
    `${p.bold("/usage")}  print token usage totals for this session`,
    `${p.bold("/exit")}   quit (or Ctrl-D; plain "exit"/"quit" won't)`,
    "",
  ]
    .map((l) => `  ${l}`)
    .join("\n");
}

export interface ReplDeps {
  readonly cwd: string;
  readonly config: Config;
  readonly version: string;
}

/** Start the interactive REPL (FR-24..FR-27, FR-34..FR-37). */
export async function startRepl(deps: ReplDeps): Promise<void> {
  const model = getModel(deps.config, "agent");
  assertToolCapable(model, "agent");

  const p = makePalette(colorEnabled());
  const promptStr = p.cyan("cody> ");

  // On a real terminal, enable bracketed paste and route input through a filter
  // so a multi-line paste is captured as one line instead of submitting at each
  // newline (FR-35). readline still handles line editing/history.
  const isTTY = Boolean(process.stdin.isTTY);
  let filter: Transform | undefined;
  let cleaned = false;
  const cleanupTerminal = (): void => {
    if (cleaned || !isTTY) return;
    cleaned = true;
    process.stdout.write(DISABLE_BRACKETED_PASTE);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // not a raw-capable stream; ignore
    }
    if (filter) process.stdin.unpipe(filter);
  };
  if (isTTY) {
    filter = createPasteFilterStream();
    process.stdin.setRawMode(true);
    process.stdin.pipe(filter);
    process.stdout.write(ENABLE_BRACKETED_PASTE);
    process.once("exit", cleanupTerminal);
  }

  const rl = createInterface({
    input: filter ?? process.stdin,
    output: process.stdout,
    prompt: promptStr,
    terminal: isTTY,
  });

  // Route the next typed line either to a pending approval prompt or the turn handler.
  let pendingAnswer: ((line: string) => void) | null = null;
  const askLine = (query: string): Promise<string> => {
    process.stdout.write(query);
    return new Promise((resolve) => {
      pendingAnswer = resolve;
    });
  };

  // The gate reads config at each tool invocation, so an "always" answer takes
  // effect immediately for the rest of the session (FR-22b).
  let liveConfig = deps.config;

  // On a denial, offer to tell the agent why — the reason lands in the tool
  // result, so the model can adapt instead of re-proposing the same action.
  const deny = async (): Promise<ConfirmResult> => {
    const reason = (await askLine(p.dim("tell the agent why? (Enter to skip) "))).trim();
    return reason ? { approved: false, reason } : { approved: false };
  };

  const confirm = async (req: ApprovalRequest): Promise<ConfirmResult> => {
    process.stdout.write(formatApproval(req, p));
    if (req.action !== "shell") {
      const answer = await askLine(`${p.bold("Apply?")} [y/N] `);
      return isAffirmative(answer) ? { approved: true } : deny();
    }
    const answer = await askLine(
      `${p.bold("Apply?")} [y/N/a] ${p.dim("(a = yes, and always allow this command)")} `,
    );
    const parsed = parseApprovalAnswer(answer);
    if (parsed === "no") return deny();
    if (parsed !== "always") return { approved: true };
    const pattern = commandToAllowPattern(req.preview);
    liveConfig = withShellAllowPattern(liveConfig, pattern);
    try {
      saveShellAllowPattern(deps.cwd, pattern);
      process.stdout.write(p.dim(`(allowlisted in cody.config.json: ${pattern})\n`));
    } catch (err) {
      process.stdout.write(
        `${p.yellow("warning:")} could not update cody.config.json ` +
          `(${(err as Error).message}) — allowed for this session only\n`,
      );
    }
    return { approved: true };
  };

  const tools = createTools({
    workdir: deps.cwd,
    get config() {
      return liveConfig;
    },
    confirm,
  });
  const agent = createAgent({ model, tools, checkpointer: new MemorySaver() });

  let threadId = "repl-0";
  let clears = 0;
  let busy = false;
  let currentAbort: AbortController | null = null;
  // Lines typed while a turn is streaming, dispatched when it ends (FR-27a).
  const queuedInputs: string[] = [];

  // session running totals for token usage
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;

  const def = modelDefForRole(deps.config, "agent");
  process.stdout.write(
    banner(p, deps.version, deps.config.permissions.mode, `${def.provider}:${def.model}`, deps.cwd),
  );

  rl.on("SIGINT", () => {
    if (currentAbort) {
      currentAbort.abort();
      pendingAnswer = null;
      return;
    }
    process.stdout.write(`\n${p.dim("(^C — type /exit or press Ctrl-D to quit)")}\n`);
    rl.prompt();
  });

  async function runTurn(input: string): Promise<void> {
    busy = true;
    currentAbort = new AbortController();
    try {
      let turnUsage: UsageTotals | undefined;
      for await (const chunk of streamAgentText(agent, input, {
        threadId,
        signal: currentAbort.signal,
        recursionLimit: deps.config.limits.recursionLimit,
        onUsage: (usage: UsageTotals) => {
          sessionInputTokens += usage.inputTokens;
          sessionOutputTokens += usage.outputTokens;
          turnUsage = usage;
        },
      })) {
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");
      // Print after the turn's trailing newline so the summary gets its own line.
      if (turnUsage && turnUsage.inputTokens + turnUsage.outputTokens > 0) {
        const sessionTotal = sessionInputTokens + sessionOutputTokens;
        process.stdout.write(
          p.dim(
            `(tokens: ${turnUsage.inputTokens} in / ${turnUsage.outputTokens} out - session: ${sessionTotal} total)\n`,
          ),
        );
      }
    } catch (err) {
      if (currentAbort.signal.aborted) process.stdout.write(`\n${p.dim("(cancelled)")}\n`);
      else process.stdout.write(`\n${p.red("error:")} ${(err as Error).message}\n`);
      // A turn that died mid tool-call leaves dangling tool_calls in the
      // thread, which providers reject on every later turn — repair it so the
      // conversation stays usable (FR-27). Best effort.
      try {
        await repairDanglingToolCalls(agent, threadId);
      } catch {
        // repair is best-effort; /clear remains the fallback
      }
    } finally {
      currentAbort = null;
      busy = false;
      drainQueuedInputs();
    }
  }

  function handleCommand(input: string): void {
    switch (parseSlash(input)) {
      case "exit":
        rl.close();
        return;
      case "help":
        process.stdout.write(helpText(p));
        break;
      case "clear":
        threadId = `repl-${(clears += 1)}`;
        process.stdout.write(p.dim("(conversation cleared)\n"));
        break;
      case "usage": {
        const sessionTotal = sessionInputTokens + sessionOutputTokens;
        process.stdout.write(
          p.dim(
            `(tokens: ${sessionInputTokens} in / ${sessionOutputTokens} out - session: ${sessionTotal} total)\n`,
          ),
        );
        break;
      }
      default:
        process.stdout.write(p.dim(`unknown command: ${input} (try /help)\n`));
    }
    rl.prompt();
  }

  function dispatch(input: string): void {
    if (isBareQuit(input)) {
      process.stdout.write(p.dim("(use /exit or press Ctrl-D to quit)\n"));
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      handleCommand(input);
      return;
    }
    void runTurn(input);
  }

  function drainQueuedInputs(): void {
    // Dispatch until a queued input starts a new turn (busy) or none are left.
    while (!busy && queuedInputs.length > 0) {
      const input = queuedInputs.shift()!;
      process.stdout.write(`${promptStr}${input} ${p.dim("(queued)")}\n`);
      dispatch(input);
    }
    if (!busy && queuedInputs.length === 0) rl.prompt();
  }

  rl.on("line", (line) => {
    if (pendingAnswer) {
      const resolve = pendingAnswer;
      pendingAnswer = null;
      resolve(line);
      return;
    }
    if (busy) {
      // Queue input typed while a turn is streaming instead of dropping it;
      // it is dispatched as soon as the turn ends (FR-27a).
      const queued = restorePaste(line).trim();
      if (queued) {
        queuedInputs.push(queued);
        process.stdout.write(p.dim(`(queued for after this turn: ${queued})\n`));
      }
      return;
    }
    const input = restorePaste(line).trim();
    if (!input) {
      rl.prompt();
      return;
    }
    dispatch(input);
  });

  rl.prompt();

  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  cleanupTerminal();
  process.stdout.write(p.dim("\nbye\n"));
}
