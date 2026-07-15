import { createInterface } from "node:readline";
import { join } from "node:path";
import { openMemoryStore, formatMemoryBreakdown } from "../memory.js";
import { HumanMessage } from "@langchain/core/messages";
import { sanitizeTitle } from "../sessions.js";
import type { Transform } from "node:stream";
import { MemorySaver } from "@langchain/langgraph";
import type { Config } from "../config.js";
import {
  modelDefForRole,
  commandToAllowPattern,
  withShellAllowPattern,
  saveShellAllowPattern,
  withMcpAllowPattern,
  saveMcpAllowPattern,
} from "../config.js";
import { getModel, assertToolCapable } from "../providers/factory.js";
import { createTools, createGatedMcpTools } from "../tools/index.js";
import type { ApprovalRequest, ConfirmResult } from "../tools/index.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent, streamAgentEvents, repairDanglingToolCalls, compactThread, serializeThread } from "../agent/graph.js";
import { createSubagentTool } from "../agent/subagent.js";
import { consolidate, reviewSessionProvisional, findOrphanedSessions } from "../consolidate.js";
import type { UsageTotals } from "../agent/graph.js";
import type { SessionStore } from "../sessions.js";
import { resolveSessionRef } from "../sessions.js";
import {
  makePalette,
  colorEnabled,
  banner,
  formatApproval,
  isAffirmative,
  parseApprovalAnswer,
  formatSessionList,
} from "./render.js";
import type { Palette } from "./render.js";
import {
  createPasteFilterStream,
  restorePaste,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from "./paste.js";

export type SlashCommand = "exit" | "clear" | "help" | "usage" | "sessions" | "resume" | "title" | "compact" | "skills" | "memory" | "remember" | "unknown";

/** Parse a slash command (pure — for testing). */
export function parseSlash(input: string): { cmd: SlashCommand; arg?: string } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { cmd: "unknown" };
  const body = trimmed.slice(1);
  if (!body) return { cmd: "unknown" };
  const firstSpace = body.search(/\s/);
  let token: string;
  let rest: string | undefined;
  if (firstSpace === -1) {
    token = body;
    rest = undefined;
  } else {
    token = body.slice(0, firstSpace);
    rest = body.slice(firstSpace + 1);
  }
  const cmd = token.toLowerCase();
  // preserve verbatim-ish arg for /title: remove the single separator leading space if present
  // and strip trailing spaces/tabs but preserve newlines; otherwise trim.
  let arg: string | undefined;
  if (!rest) arg = undefined;
  else if (cmd === "title" || cmd === "remember") {
    let a = rest;
    if (a.startsWith(" ")) a = a.slice(1);
    a = a.replace(/[ \t]+$/g, "");
    arg = a;
  } else {
    arg = rest.trim();
  }
  if (cmd === "exit" || cmd === "quit") return { cmd: "exit", arg };
  if (cmd === "clear") return { cmd: "clear", arg };
  if (cmd === "help") return { cmd: "help", arg };
  if (cmd === "usage") return { cmd: "usage", arg };
  if (cmd === "sessions") return { cmd: "sessions", arg };
  if (cmd === "resume") return { cmd: "resume", arg };
  if (cmd === "title") return { cmd: "title", arg };
  if (cmd === "compact") return { cmd: "compact", arg };
  if (cmd === "memory") return { cmd: "memory", arg };
  if (cmd === "remember") return { cmd: "remember", arg };
  return { cmd: "unknown", arg };
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
    `${p.bold("/sessions")} list known sessions (if enabled)`,
    `${p.bold("/resume")}   resume a previous session`,
    `${p.bold("/title")}   view or set a manual session title`,
    `${p.bold("/compact")}  compact the current session into a fresh one`,
    `${p.bold("/memory")} show recorded failure-memory stats`,
    `${p.bold("/remember")} save a durable note to memory`,
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
  readonly store?: SessionStore;
  readonly resumeTarget?: string;
  readonly rawMcpTools?: StructuredToolInterface[];
  readonly mcpSummaries?: import("../tools/mcp.js").McpServerSummary[];
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
    // For shell and MCP actions, offer the 'always' option; for others, plain y/N.
    if (req.action !== "shell" && req.action !== "mcp") {
      const answer = await askLine(`${p.bold("Apply?")} [y/N] `);
      return isAffirmative(answer) ? { approved: true } : deny();
    }

    const answer = await askLine(
      `${p.bold("Apply?")} [y/N/a] ${p.dim("(a = yes, and always allow this command) ")}`,
    );
    const parsed = parseApprovalAnswer(answer);
    if (parsed === "no") return deny();
    if (parsed !== "always") return { approved: true };

    // 'always' selected: if MCP tool and subject present, add to MCP allowlist.
    if (req.action === "mcp" && req.subject) {
      const pattern = commandToAllowPattern(req.subject);
      liveConfig = withMcpAllowPattern(liveConfig, pattern);
      try {
        saveMcpAllowPattern(deps.cwd, pattern);
        process.stdout.write(p.dim(`(mcp tool allowlisted in cody.config.json: ${pattern})\n`));
      } catch (err) {
        process.stdout.write(
          `${p.yellow("warning:")} could not update cody.config.json ` +
            `(${(err as Error).message}) — allowed for this session only\n`,
        );
      }
      return { approved: true };
    }

    // Fallback: shell allowlist behavior
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

  const store = deps.store;
  const saver = store ? store.saver : new MemorySaver();

  // open memory store once for the process (best-effort) BEFORE assembling the system prompt
  let memory: import("../memory.js").MemoryStore | undefined = undefined;
  try {
    memory = openMemoryStore(join(deps.cwd, ".cody", "memory.db"));
  } catch {
    // best-effort
  }

  // Build the agent prompt possibly augmented with MCP server summaries and startup digest from memories
  const promptModule = await import("../agent/prompt.js");
  // build skills catalog and include in system prompt
  const skillsModule = await import("../skills.js");
  const skills = skillsModule.loadSkillsCatalog(deps.cwd);

  // compute startup digest once (best-effort)
  let digest: import("../memory.js").MemoryRow[] = [];
  try {
    digest = memory ? memory.topMemories(8) : [];
  } catch {
    digest = [];
  }

  const systemPrompt = promptModule.withMemories(
    promptModule.withSkills(promptModule.withMcpServers(promptModule.SYSTEM_PROMPT, deps.mcpSummaries ?? []), skills),
    digest,
  );

  let sessionId: string | undefined;

  // Serialize approval prompts so concurrent ask-gated calls don't fight over readline.
  let confirmChain: Promise<unknown> = Promise.resolve();
  const serializedConfirm = (confirmImpl: (req: ApprovalRequest) => Promise<ConfirmResult>) => {
    return (req: ApprovalRequest): Promise<ConfirmResult> => {
      const p = confirmChain.then(() => confirmImpl(req));
      confirmChain = p.then(() => undefined, () => undefined); // keep chain alive on denial/error
      return p;
    };
  };

  const ctx = {
    workdir: deps.cwd,
    get config() {
      return liveConfig;
    },
    confirm: serializedConfirm(confirm),
    memory,
    get sessionId() {
      return sessionId;
    },
  };

  const tools = [
    ...createTools(ctx as unknown as import("../tools/index.js").ToolContext),
    ...(deps.rawMcpTools ? createGatedMcpTools(ctx as unknown as import("../tools/index.js").ToolContext, deps.rawMcpTools) : []),
  ];

  // Subagent: use the "subagent" role model if configured, else the parent model.
  const subagentModel = deps.config.roles.subagent
    ? getModel(deps.config, "subagent")
    : model;
  const runSubagent = createSubagentTool({
    model: subagentModel,
    ctx: ctx as unknown as import("../tools/index.js").ToolContext,
    onUsage: (usage) => {
      sessionInputTokens += usage.inputTokens;
      sessionOutputTokens += usage.outputTokens;
    },
  });
  tools.push(runSubagent);

  const agent = createAgent({ model, tools, checkpointer: saver, systemPrompt, memory, sessionId: () => sessionId });

  // Recover a session's transcript from its own checkpointed state, for
  // reviewing PROVISIONAL memories it left behind (see reviewSessionProvisional).
  // Returns undefined if there's too little history or the checkpoint is gone.
  async function getSessionTranscript(id: string): Promise<string | undefined> {
    try {
      const state = await agent.getState({ configurable: { thread_id: id } });
      const messages = (state.values as { messages?: import("@langchain/core/messages").BaseMessage[] }).messages ?? [];
      if (messages.length < 3) return undefined;
      return serializeThread(messages);
    } catch {
      return undefined;
    }
  }
  // undefined = sessions not used; null = awaiting first input; string = already set to first input consumed? We'll store first input value separately.
  let sessionFirstInputValue: string | null | undefined = undefined;
  // capture the initial user request for auto-title generation; persists for the session
  let sessionInitialRequest: string | undefined;
  // guard concurrent title generations per session id
  const titleGenerationInFlight = new Map<string, boolean>();

  if (store) {
    // resumeTarget takes precedence when provided
    sessionId = deps.resumeTarget ?? store.newSessionId();
    // register only when we created a new id (i.e., no resume target)
    if (!deps.resumeTarget) store.register(sessionId);
    // await repair of dangling calls if resuming
    if (deps.resumeTarget) {
      try {
        await repairDanglingToolCalls(agent, sessionId);
      } catch {
        // best-effort
      }
    }
    // mark that we are awaiting the first input value
    sessionFirstInputValue = null;
  }

  // Best-effort startup orphan sweep: a session that is killed, crashes, or is
  // restarted before it reaches /compact or a clean exit otherwise leaves its
  // PROVISIONAL memories unreviewed forever — they were only ever reviewed at
  // those two boundaries, scoped to their own session. Each new session sweeps
  // any OTHER session's leftover provisional memories, using that session's
  // own persisted checkpoint transcript, so they eventually get promoted or
  // pruned instead of accumulating. Runs in the background (fire-and-forget):
  // never blocks the prompt, and a sweep that can't recover a transcript just
  // leaves those memories for the next sweep to retry.
  if (store && memory) {
    const mem = memory;
    const orphanSessionIds = findOrphanedSessions(mem, sessionId);
    if (orphanSessionIds.length > 0) {
      void (async () => {
        try {
          const reviewModel = getModel(deps.config, "memory");
          for (const sid of orphanSessionIds) {
            await reviewSessionProvisional(mem, reviewModel, sid, getSessionTranscript).catch(() => undefined);
          }
        } catch {
          // best-effort
        }
      })();
    }
  }

  let threadId = sessionId ? sessionId : "repl-0";
  let clears = 0;
  let busy = false;
  let currentAbort: AbortController | null = null;
  // Lines typed while a turn is streaming, dispatched when it ends (FR-27a).
  const queuedInputs: string[] = [];

  // session running totals for token usage
  let sessionInputTokens = 0;
  let sessionOutputTokens = 0;

  const def = modelDefForRole(deps.config, "agent");
  const sessionLine = sessionId ? `${p.dim(`session: ${sessionId}`)}\n` : "";
  process.stdout.write(
    banner(p, deps.version, deps.config.permissions.mode, `${def.provider}:${def.model}`, deps.cwd) + sessionLine,
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
    // capture first input value for session if applicable
    if (store && sessionFirstInputValue === null) {
      sessionFirstInputValue = input;
      sessionInitialRequest = input;

      // Auto-title (best-effort): if store present, sessionId set, and session has no manual title,
      // fire an async background title generation (no await). Guard so we only run one per session at a time.
      try {
        if (store && sessionId) {
          const s = store.list().find((x) => x.id === sessionId);
          const hasTitle = !!(s && s.title && s.title.length > 0);
          if (!hasTitle && !titleGenerationInFlight.get(sessionId)) {
            titleGenerationInFlight.set(sessionId, true);
            // fire-and-forget
            (async () => {
              try {
                const titleModel = getModel(deps.config, "title");
                const human = new HumanMessage(
                  `Write a concise title, at most 8 words, for a coding session that begins with this user request:\n${sessionInitialRequest ?? ""}\nReply with ONLY the title.`,
                );
                // invoke the chat model with an array of messages
                const res = await titleModel.invoke([human]);
                // chat model invoke returns a single AIMessage-like object with .content
                const content = (res as { content?: unknown }).content;
                if (typeof content === "string") {
                  const t = sanitizeTitle(content);
                  if (t && t.length > 0) {
                    try {
                      store.setTitle(sessionId!, t);
                    } catch {
                      // ignore errors
                    }
                  }
                }
              } catch {
                // best-effort
              } finally {
                titleGenerationInFlight.set(sessionId!, false);
              }
            })();
          }
        }
      } catch {
        // swallow
      }
    }

    busy = true;
    currentAbort = new AbortController();
    try {
      let turnUsage: UsageTotals | undefined;
      let atLineStart = true;
      for await (const event of streamAgentEvents(agent, input, {
        threadId,
        signal: currentAbort.signal,
        recursionLimit: deps.config.limits.recursionLimit,
        onUsage: (usage: UsageTotals) => {
          sessionInputTokens += usage.inputTokens;
          sessionOutputTokens += usage.outputTokens;
          turnUsage = usage;
          // touch the store if present; pass the first input once, then null
          if (store && sessionId) {
            const toPass = sessionFirstInputValue === undefined ? null : sessionFirstInputValue;
            try {
              store.touch(sessionId, toPass, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
            } catch {
              // best-effort
            }
            // after first touch, ensure we pass null next time
            sessionFirstInputValue = undefined;
          }
        },
      })) {
        if (event.kind === "text") {
          process.stdout.write(event.text);
          atLineStart = event.text.endsWith("\n");
        } else {
          // One dim line per completed tool run (FR-25), on its own line.
          if (!atLineStart) process.stdout.write("\n");
          const marker = event.status === "ok" ? "" : ` ${p.yellow(`[${event.status}]`)}`;
          process.stdout.write(`${p.dim(`→ ${event.name} ${event.input}`)}${marker}\n`);
          atLineStart = true;
        }
      }
      if (!atLineStart) process.stdout.write("\n");
      // Print after the turn's trailing newline so the summary gets its own line.
      if (turnUsage && turnUsage.inputTokens + turnUsage.outputTokens > 0) {
        const sessionTotal = sessionInputTokens + sessionOutputTokens;
        process.stdout.write(
          p.dim(
            `(tokens: ${turnUsage.inputTokens} in / ${turnUsage.outputTokens} out - session: ${sessionTotal} total)\n`,
          ),
        );

        // Auto-compaction: if configured and this turn's context input tokens exceed the threshold,
        // perform an inline auto-compaction. This runs before the auto-title work so the session id may change.
        try {
          const thresh = deps.config.limits.compactThresholdTokens;
          if (typeof thresh === "number" && thresh > 0 && turnUsage && turnUsage.inputTokens > thresh) {
            process.stdout.write(p.dim(`(context exceeds ${thresh} tokens - auto-compacting...)\n`));
            // don't let failures block the prompt; doCompact swallows errors
            await doCompact("auto");
          }
        } catch {
          // swallow any unexpected errors from auto-compact attempt
        }

        // Auto-title (best-effort): if store present, sessionId set, and session has no manual title,
        // fire an async background title generation (no await). Guard so we only run one per session at a time.
        try {
          if (store && sessionId) {
            const s = store.list().find((x) => x.id === sessionId);
            const hasTitle = !!(s && s.title && s.title.length > 0);
            if (!hasTitle && !titleGenerationInFlight.get(sessionId)) {
              titleGenerationInFlight.set(sessionId, true);
              // fire-and-forget
              (async () => {
                try {
                  const titleModel = getModel(deps.config, "title");
                  const human = new HumanMessage(
                    `Write a concise title, at most 8 words, for a coding session that begins with this user request:\n${sessionInitialRequest ?? ""}\nReply with ONLY the title.`,
                  );
                  // invoke the chat model with an array of messages
                  const res = await titleModel.invoke([human]);
                  // chat model invoke returns a single AIMessage-like object with .content
                  const content = (res as { content?: unknown }).content;
                  if (typeof content === "string") {
                    const t = sanitizeTitle(content);
                    if (t && t.length > 0) {
                      try {
                        store.setTitle(sessionId!, t);
                      } catch {
                        // ignore errors
                      }
                    }
                  }
                } catch {
                  // best-effort
                } finally {
                  titleGenerationInFlight.set(sessionId!, false);
                }
              })();
            }
          }
        } catch {
          // swallow
        }
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

  async function consolidateThread(id: string): Promise<void> {
    try {
      if (!memory) return;
      const state = await agent.getState({ configurable: { thread_id: id } });
      const messages = (state.values as { messages?: import("@langchain/core/messages").BaseMessage[] }).messages ?? [];
      if (messages.length < 3) return;
      const transcript = serializeThread(messages);
      const model = getModel(deps.config, "memory");
      const records = await consolidate(model, transcript).catch(() => []);
      let wrote = 0;
      for (const r of records) {
        try {
          memory.insertMemory({ kind: r.kind, cue: r.cue ?? "", triggerText: r.triggerText, body: r.body, scope: r.scope, confidence: r.confidence ?? 1, sourceSession: id });
          wrote += 1;
        } catch {
          // continue
        }
      }
      if (wrote > 0) process.stdout.write(p.dim(`(consolidated ${wrote} memor${wrote === 1 ? "y" : "ies"} from this session)\n`));

      // Review this session's PROVISIONAL memories against the transcript and
      // promote confirmed ones / prune the rest. Best-effort — never breaks compaction/exit.
      try {
        // reuse the transcript already fetched above instead of refetching state
        const { promoted, pruned } = await reviewSessionProvisional(memory, model, id, async () => transcript);
        if (promoted > 0 || pruned > 0) {
          process.stdout.write(
            p.dim(`(reviewed ${promoted + pruned} provisional memories: ${promoted} promoted, ${pruned} pruned)\n`),
          );
        }
      } catch {
        // swallow
      }
    } catch {
      // swallow
    }
  }

  async function doCompact(trigger: "manual" | "auto"): Promise<void> {
    if (trigger === "manual") process.stdout.write(p.dim("(compacting...)\n"));
    try {
      const summarizer = getModel(deps.config, "compact");
      // before compacting, consolidate the old thread (best-effort)
      try {
        await consolidateThread(threadId);
      } catch {
        // swallow
      }
      const newId = store ? store.newSessionId() : `repl-compact-${(clears += 1)}`;
      const { messageCount, summary } = await compactThread(agent, summarizer, threadId, newId);
      if (store) {
        store.register(newId);
        try {
          store.touch(newId, summary.slice(0, 80), { inputTokens: 0, outputTokens: 0 });
        } catch {
          // best-effort
        }
      }
      sessionId = store ? newId : sessionId;
      threadId = newId;
      process.stdout.write(p.dim(`(compacted ${messageCount} messages into a new session ${newId})\n`));
    } catch (err) {
      process.stdout.write(
        `${p.red("compaction failed:")} ${(err as Error).message} — staying on the current session\n`,
      );
      // do not rethrow; auto-compaction must not prevent prompt from returning
    }
  }

  async function handleCommand(input: string): Promise<void> {
    const parsed = parseSlash(input);
    switch (parsed.cmd) {
      case "skills": {
        const skillsModule = await import("../skills.js");
        const skills = skillsModule.loadSkillsCatalog(deps.cwd);
        if (!skills || skills.length === 0) {
          process.stdout.write("(no skills installed)\n");
        } else {
          for (const s of skills) process.stdout.write(`- ${s.name} [${s.tags.join(",")}]: ${s.description}\n`);
        }
        rl.prompt();
        return;
      }
      case "exit":
        rl.close();
        return;
      case "help":
        process.stdout.write(helpText(p));
        break;
      case "clear":
        if (store) {
          // start a fresh registered session id
          const newId = store.newSessionId();
          store.register(newId);
          threadId = newId;
          sessionId = newId;
          sessionFirstInputValue = null;
          process.stdout.write(p.dim("(conversation cleared, new session started)\n"));
        } else {
          threadId = `repl-${(clears += 1)}`;
          process.stdout.write(p.dim("(conversation cleared)\n"));
        }
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
      case "sessions": {
        if (!store) {
          process.stdout.write(p.dim("(session persistence is disabled)\n"));
          break;
        }
        const list = store.list();
        process.stdout.write(formatSessionList(list, p, sessionId));
        break;
      }
      case "resume": {
        if (!store) {
          process.stdout.write(p.dim("(session persistence is disabled)\n"));
          break;
        }
        if (!parsed.arg) {
          process.stdout.write(formatSessionList(store.list(), p, sessionId));
          process.stdout.write(p.dim("usage: /resume <n|id>\n"));
          break;
        }
        const res = resolveSessionRef(parsed.arg, store.list());
        if (!res.ok) {
          process.stdout.write(p.dim(res.message + "\n"));
          break;
        }
        const id = res.id;
        sessionId = id;
        threadId = id;
        sessionFirstInputValue = undefined;
        try {
          await repairDanglingToolCalls(agent, id);
        } catch {
          // best-effort
        }
        process.stdout.write(p.dim(`(resumed session ${id})\n`));
        break;
      }
      case "title": {
        // view or set manual session title
        if (!store) {
          process.stdout.write(p.dim("(session persistence is disabled)\n"));
          break;
        }
        if (!sessionId) {
          process.stdout.write(p.dim("(no session)\n"));
          break;
        }
        if (!parsed.arg) {
          const list = store.list();
          const s = list.find((x) => x.id === sessionId);
          const t = s ? s.title : undefined;
          process.stdout.write(p.dim((t && t.length > 0 ? t : "(untitled)") + "\n"));
          break;
        }
        store.setTitle(sessionId, parsed.arg);
        process.stdout.write(p.dim("(title set)\n"));
        break;
      }
      case "compact": {
        // Manual compact reuses the same doCompact path so behavior matches auto-compaction.
        await doCompact("manual");
        break;
      }
      case "memory": {
        if (!memory) {
          process.stdout.write(p.dim("(memory store unavailable)\n"));
          break;
        }
        try {
          const failureCount = memory.failureCount();
          const distinctFingerprintCount = memory.distinctFingerprintCount();
          process.stdout.write(`memory: ${failureCount} failures, ${distinctFingerprintCount} distinct fingerprints\n`);
          if (failureCount > 0) {
            process.stdout.write(`top recurring:\n`);
            for (const row of memory.topFingerprints(10)) {
              let sample = (row.sampleText ?? "").replace(/\s+/g, " ").trim();
              if (sample.length > 70) sample = sample.slice(0, 70);
              process.stdout.write(`  ${row.count}x ${row.fingerprint} ${sample}\n`);
            }
          }
          process.stdout.write(`${formatMemoryBreakdown(memory.originStatusBreakdown())}\n`);
        } catch {
          process.stdout.write(p.dim("(memory store unavailable)\n"));
        }
        break;
      }
      case "remember": {
        if (!memory) {
          process.stdout.write(p.dim("(memory store unavailable)\n"));
          break;
        }
        if (!parsed.arg) {
          process.stdout.write(p.dim("usage: /remember <text>\n"));
          break;
        }
        try {
          const id = memory.insertMemory({
            kind: "decision",
            cue: parsed.arg.slice(0, 80),
            triggerText: parsed.arg,
            body: parsed.arg,
            status: "active",
            origin: "user",
            confidence: 3,
            sourceSession: sessionId,
          });
          process.stdout.write(p.dim(`(remembered #${id})\n`));
        } catch {
          process.stdout.write(p.dim("(could not record memory)\n"));
        }
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
      void handleCommand(input);
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

  // On REPL close, attempt to consolidate the thread and prune checkpoints for the current session (best-effort)
  try {
    if (store && sessionId) {
      try {
        // consolidate current thread before pruning checkpoints; best-effort
        try {
          await consolidateThread(threadId);
        } catch {
          // swallow
        }
        store.pruneCheckpoints(sessionId);
      } catch {
        // best-effort
      }
    }
  } catch {
    // swallow
  }

  // Close memory store if opened (best-effort)
  try {
    if (memory) {
      try {
        memory.close();
      } catch {
        // best-effort
      }
    }
  } catch {
    // swallow
  }
}

