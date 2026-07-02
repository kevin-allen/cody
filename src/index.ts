#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "./cli.js";
import { loadConfig, modelDefForRole } from "./config.js";
import { getModel, assertToolCapable } from "./providers/factory.js";
import { TOOL_INFO, resolvePolicy, createTools } from "./tools/index.js";
import type { ApprovalRequest, ConfirmResult } from "./tools/index.js";
import { createAgent, streamAgentText } from "./agent/graph.js";
import { configureProxyFromEnv } from "./net/proxy.js";
import { startRepl } from "./ui/repl.js";
import { openSessionStore, resolveSessionRef } from "./sessions.js";
import { makePalette, colorEnabled, formatSessionList } from "./ui/render.js";

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

  if (
    argv.includes("-h") ||
    argv.includes("--help") ||
    argv.includes("-v") ||
    argv.includes("--version")
  ) {
    const result = runCli(argv, readVersion());
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.exitCode;
    return;
  }

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
    const confirm = (req: ApprovalRequest): Promise<ConfirmResult> => {
      process.stderr.write(
        `[headless: auto-denying "${req.action}"; re-run with --auto to allow]\n`,
      );
      return Promise.resolve({
        approved: false,
        reason:
          "headless mode auto-denies approvals; work with what read-only and " +
          "allowlisted tools can provide, or tell the user to re-run with --auto",
      });
    };
    const tools = createTools({ workdir: process.cwd(), config, confirm });
    const agent = createAgent({ model, tools });
    for await (const chunk of streamAgentText(agent, task, {
      recursionLimit: config.limits.recursionLimit,
    }))
      process.stdout.write(chunk);
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

  // No recognized subcommand -> start the interactive REPL.
  const config = loadConfig({ cwd: process.cwd(), env: process.env, argv });

  // REPL-only flags: --continue (start/resume session) and --resume <id>
  const replFlags = argv.slice();
  const resumeIndex = replFlags.indexOf("--resume");
  let resumeId: string | undefined;
  // treat missing next argv or a next argv that starts with - as a bare --resume
  if (resumeIndex >= 0) {
    const next = replFlags[resumeIndex + 1];
    if (typeof next === "string" && !next.startsWith("-")) resumeId = next;
  }
  const continueFlag = replFlags.includes("--continue");

  let store: ReturnType<typeof openSessionStore> | undefined;
  let resumeTarget: string | undefined;
  if (config.sessions.enabled) {
    const dbPath = config.sessions.path ?? join(process.cwd(), ".cody", "sessions.db");
    store = openSessionStore(dbPath);
    if (resumeId) {
      const res = resolveSessionRef(resumeId, store.list());
      if (!res.ok) {
        process.stderr.write(res.message + "\n");
        process.stderr.write(formatSessionList(store.list(), makePalette(colorEnabled()), undefined));
        process.exitCode = 1;
        return;
      }
      resumeTarget = res.id;
    } else if (resumeIndex >= 0) {
      // bare --resume handling: prompt the user unless there are no sessions
      const list = store.list();
      if (list.length === 0) {
        // start a new one: leave resumeTarget undefined
      } else {
        process.stdout.write(formatSessionList(list, makePalette(colorEnabled()), undefined));
        // prompt once
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("resume which? [1-" + list.length + ", Enter = new session] ", resolve));
        rl.close();
        const ans = answer.trim();
        if (ans.length === 0) {
          // new session
        } else {
          const res = resolveSessionRef(ans, list);
          if (!res.ok) {
            process.stderr.write(res.message + "\n");
            process.exitCode = 1;
            return;
          }
          resumeTarget = res.id;
        }
      }
    } else if (continueFlag) {
      // start/resume: resume the most recent session when one exists,
      // otherwise start a new one (leave resumeTarget undefined)
      const latest = store.list()[0]?.id ?? store.latest();
      // prefer latest() but fall back to list ordering in case
      resumeTarget = latest ? latest : undefined;
    }
  } else {
    // sessions disabled and user asked for the sessions subcommand -> print and exit
    if (command === "sessions") {
      process.stdout.write("(session persistence is disabled)\n");
      return;
    }
  }

  // sessions subcommand: print list and exit
  if (command === "sessions") {
    if (!config.sessions.enabled) {
      process.stdout.write("(session persistence is disabled)\n");
      return;
    }
    const dbPath = config.sessions.path ?? join(process.cwd(), ".cody", "sessions.db");
    const s = openSessionStore(dbPath);
    process.stdout.write(formatSessionList(s.list(), makePalette(colorEnabled()), undefined));
    s.close();
    return;
  }

  const replPromise = startRepl({ cwd: process.cwd(), config, version: readVersion(), store, resumeTarget });
  await replPromise.finally(() => {
    if (store) store.close();
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`cody: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
