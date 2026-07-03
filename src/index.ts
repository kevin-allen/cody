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
import { configureProxyFromEnv, relaxTlsVerification } from "./net/proxy.js";
import { startRepl } from "./ui/repl.js";
import { connectMcpServers } from "./tools/mcp.js";
import { createGatedMcpTools } from "./tools/index.js";
import { openSessionStore, resolveSessionRef } from "./sessions.js";
import { openMemoryStore, formatMemoryBreakdown } from "./memory.js";
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

    // Attempt MCP connection for run mode as well (wrap tools with gating)
    try {
      if (Object.values(config.mcp.servers ?? {}).some((s) => s?.insecureTls)) {
        relaxTlsVerification();
      }
    } catch {
      /* ignore */
    }
      let mcpForRun: { rawTools: import("@langchain/core/tools").StructuredToolInterface[]; summaries: import("./tools/mcp.js").McpServerSummary[]; close: () => Promise<void> } | undefined;
    try {
      mcpForRun = await connectMcpServers(config) as unknown as typeof mcpForRun;
    } catch (err) {
      process.stderr.write(`warning: failed to connect to MCP servers: ${(err as Error).message}\n`);
    }

    const baseCtx = { workdir: process.cwd(), config, confirm } as unknown as import("./tools/index.js").ToolContext;
    const tools = [
      ...createTools(baseCtx),
      ...(mcpForRun ? createGatedMcpTools(baseCtx, mcpForRun.rawTools) : []),
    ];

    try {
      const promptModule = await import("./agent/prompt.js");
      const { loadSkillsCatalog } = await import("./skills.js");
      const systemPrompt = promptModule.withSkills(
        promptModule.withMcpServers(promptModule.SYSTEM_PROMPT, mcpForRun?.summaries ?? []),
        loadSkillsCatalog(process.cwd()),
      );
      const agent = createAgent({ model, tools, systemPrompt });
      for await (const chunk of streamAgentText(agent, task, {
        recursionLimit: config.limits.recursionLimit,
      }))
        process.stdout.write(chunk);
      process.stdout.write("\n");
    } finally {
      if (mcpForRun) await mcpForRun.close();
    }
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
    if (Object.keys(config.mcp.servers).length > 0) {
      if (Object.values(config.mcp.servers).some((s) => s.insecureTls)) relaxTlsVerification();
      try {
        const mcp = await connectMcpServers(config);
        if (mcp) {
          const policy = resolvePolicy(config.permissions, "mcp");
          process.stdout.write(`\nMCP tools:\n`);
          for (const t of mcp.rawTools) {
            process.stdout.write(
              `  ${t.name.padEnd(28)} mcp    ${policy.padEnd(6)} ${(t.description ?? "").slice(0, 60)}\n`,
            );
          }
          await mcp.close();
        }
      } catch (err) {
        process.stderr.write(`warning: MCP server connection failed: ${(err as Error).message}\n`);
      }
    }
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
    // if a prune subcommand is given, prune all sessions
    if (argv[1] === "prune") {
      let totalPruned = 0;
      let sessionsCounted = 0;
      for (const row of s.list()) {
        try {
          const n = s.pruneCheckpoints(row.id);
          if (n > 0) totalPruned += n;
          sessionsCounted += 1;
        } catch {
          // best-effort
          sessionsCounted += 1;
        }
      }
      s.close();
      process.stdout.write(`pruned ${totalPruned} old checkpoints across ${sessionsCounted} sessions\n`);
      return;
    }
    process.stdout.write(formatSessionList(s.list(), makePalette(colorEnabled()), undefined));
    s.close();
    return;
  }

  // memory subcommand: print failure stats and exit
  if (command === "memory") {
    try {
      const m = openMemoryStore(join(process.cwd(), ".cody", "memory.db"));
      try {
        const failureCount = m.failureCount();
        const distinctFingerprintCount = m.distinctFingerprintCount();
        process.stdout.write(`memory: ${failureCount} failures, ${distinctFingerprintCount} distinct fingerprints\n`);
        if (failureCount > 0) {
          process.stdout.write(`top recurring:\n`);
          for (const row of m.topFingerprints(10)) {
            let sample = (row.sampleText ?? "").replace(/\s+/g, " ").trim();
            if (sample.length > 70) sample = sample.slice(0, 70);
            process.stdout.write(`  ${row.count}x ${row.fingerprint} ${sample}\n`);
          }
        }
        process.stdout.write(`${formatMemoryBreakdown(m.originStatusBreakdown())}\n`);
      } finally {
        try { m.close(); } catch { /* best-effort */ }
      }
    } catch {
      process.stdout.write("memory: (could not open memory store)\n");
    }
    return;
  }

  // Attempt to connect to MCP servers (if any). If any server requests insecureTls,
  // relax TLS verification for the process.
  try {
    if (Object.values(config.mcp.servers ?? {}).some((s) => s?.insecureTls)) {
      relaxTlsVerification();
    }
  } catch {
    // ignore
  }

  let mcp: { rawTools: import("@langchain/core/tools").StructuredToolInterface[]; summaries?: import("./tools/mcp.js").McpServerSummary[]; close: () => Promise<void> } | undefined;
  try {
    mcp = await connectMcpServers(config) as unknown as typeof mcp;
  } catch (err) {
    process.stderr.write(`warning: failed to connect to MCP servers: ${(err as Error).message}\n`);
  }

  // No recognized subcommand -> start the interactive REPL.
  const replPromise = startRepl({ cwd: process.cwd(), config, version: readVersion(), store, resumeTarget, rawMcpTools: mcp?.rawTools, mcpSummaries: mcp?.summaries });
  await replPromise.finally(async () => {
    if (store) store.close();
    if (mcp) await mcp.close();
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`cody: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
