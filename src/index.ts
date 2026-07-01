#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { runCli } from "./cli.js";
import { loadConfig, modelDefForRole } from "./config.js";
import { getModel, assertToolCapable } from "./providers/factory.js";
import { TOOL_INFO, resolvePolicy, createTools } from "./tools/index.js";
import type { ApprovalRequest } from "./tools/index.js";
import { createAgent, streamAgentText } from "./agent/graph.js";
import { configureProxyFromEnv } from "./net/proxy.js";

// Route hosted-provider HTTP through the standard proxy env vars when set
// (honoring NO_PROXY, so local Ollama bypasses the proxy). Must run before any
// model/client is constructed.
configureProxyFromEnv();

// Exit quietly when a downstream reader (e.g. `head`, `less`) closes the pipe,
// rather than crashing on an unhandled EPIPE (FR-37: degrade cleanly when piped).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

/** Read the package version from the shipped package.json (next to dist/). */
function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "run") {
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    const task = argv
      .slice(1)
      .filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim();
    if (!task) {
      process.stderr.write('cody run: provide a task, e.g. cody run "summarize the README"\n');
      process.exitCode = 1;
      return;
    }
    const model = getModel(config, "agent");
    assertToolCapable(model, "agent");
    // Headless: no interactive prompt exists yet, so an `ask` policy auto-denies.
    // The interactive REPL (milestone 5) supplies a real prompt. Use --auto to allow.
    const confirm = (req: ApprovalRequest): Promise<boolean> => {
      process.stderr.write(
        `[headless: auto-denying "${req.action}"; re-run with --auto to allow]\n`,
      );
      return Promise.resolve(false);
    };
    const tools = createTools({ workdir: process.cwd(), config, confirm });
    const agent = createAgent({ model, tools });
    for await (const chunk of streamAgentText(agent, task)) process.stdout.write(chunk);
    process.stdout.write("\n");
    return;
  }

  if (command === "config") {
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    const agent = modelDefForRole(config, "agent");
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`\nagent role -> ${agent.provider}:${agent.model}\n`);
    return;
  }

  if (command === "tools") {
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    process.stdout.write(`permission mode: ${config.permissions.mode}\n\n`);
    for (const t of TOOL_INFO) {
      const policy = resolvePolicy(config.permissions, t.action);
      process.stdout.write(
        `  ${t.name.padEnd(12)} ${t.action.padEnd(6)} ${policy.padEnd(6)} ${t.description}\n`,
      );
    }
    process.stdout.write(
      `\nshell denylist (applies in every mode): ${config.permissions.shell.deny.join(", ")}\n`,
    );
    return;
  }

  if (command === "model") {
    const role = argv[1] ?? "agent";
    const config = loadConfig({ cwd: process.cwd(), env: process.env, argv: argv.slice(1) });
    const def = modelDefForRole(config, role);
    const model = getModel(config, role); // throws with a clear message if the API key is missing
    assertToolCapable(model, role);
    process.stdout.write(`${role} -> ${def.provider}:${def.model} (tool-calling: ok)\n`);
    return;
  }

  const result = runCli(argv, readVersion());
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}

main().catch((err: unknown) => {
  process.stderr.write(`cody: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
