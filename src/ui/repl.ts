import { createInterface } from "node:readline";
import { MemorySaver } from "@langchain/langgraph";
import type { Config } from "../config.js";
import { modelDefForRole } from "../config.js";
import { getModel, assertToolCapable } from "../providers/factory.js";
import { createTools } from "../tools/index.js";
import type { ApprovalRequest } from "../tools/index.js";
import { createAgent, streamAgentText } from "../agent/graph.js";
import { makePalette, colorEnabled, banner, formatApproval, isAffirmative } from "./render.js";
import type { Palette } from "./render.js";

export type SlashCommand = "exit" | "clear" | "help" | "unknown";

/** Parse a slash command (pure — for testing). */
export function parseSlash(input: string): SlashCommand {
  const cmd = input.trim().slice(1).trim().toLowerCase();
  if (cmd === "exit" || cmd === "quit") return "exit";
  if (cmd === "clear") return "clear";
  if (cmd === "help") return "help";
  return "unknown";
}

function helpText(p: Palette): string {
  return [
    `${p.bold("/help")}   show this help`,
    `${p.bold("/clear")}  start a fresh conversation`,
    `${p.bold("/exit")}   quit (or Ctrl-D)`,
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
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: promptStr });

  // Route the next typed line either to a pending approval prompt or the turn handler.
  let pendingAnswer: ((line: string) => void) | null = null;
  const askLine = (query: string): Promise<string> => {
    process.stdout.write(query);
    return new Promise((resolve) => {
      pendingAnswer = resolve;
    });
  };

  const confirm = async (req: ApprovalRequest): Promise<boolean> => {
    process.stdout.write(formatApproval(req, p));
    const answer = await askLine(`${p.bold("Apply?")} [y/N] `);
    return isAffirmative(answer);
  };

  const tools = createTools({ workdir: deps.cwd, config: deps.config, confirm });
  const agent = createAgent({ model, tools, checkpointer: new MemorySaver() });

  let threadId = "repl-0";
  let clears = 0;
  let busy = false;
  let currentAbort: AbortController | null = null;

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
      for await (const chunk of streamAgentText(agent, input, {
        threadId,
        signal: currentAbort.signal,
      })) {
        process.stdout.write(chunk);
      }
      process.stdout.write("\n");
    } catch (err) {
      if (currentAbort.signal.aborted) process.stdout.write(`\n${p.dim("(cancelled)")}\n`);
      else process.stdout.write(`\n${p.red("error:")} ${(err as Error).message}\n`);
    } finally {
      currentAbort = null;
      busy = false;
      rl.prompt();
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
      default:
        process.stdout.write(p.dim(`unknown command: ${input} (try /help)\n`));
    }
    rl.prompt();
  }

  rl.on("line", (line) => {
    if (pendingAnswer) {
      const resolve = pendingAnswer;
      pendingAnswer = null;
      resolve(line);
      return;
    }
    if (busy) return; // ignore input typed while a turn is streaming
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      handleCommand(input);
      return;
    }
    void runTurn(input);
  });

  rl.prompt();

  await new Promise<void>((resolve) => rl.on("close", () => resolve()));
  process.stdout.write(p.dim("\nbye\n"));
}
