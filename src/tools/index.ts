import { tool } from "@langchain/core/tools";
import { fingerprintError } from "../memory.js";
import type { MemoryStore } from "../memory.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { Config, ToolAction } from "../config.js";
import { resolvePolicy, isShellDenied, isShellAllowed } from "./permissions.js";
import {
  readFileWithin,
  listDirWithin,
  globWithin,
  grepWithin,
  prepareWrite,
  prepareEdit,
} from "./fs.js";
import { resolveWithinWorkdir } from "./paths.js";
import { runShell } from "./shell.js";

export { resolvePolicy, isShellDenied, isShellAllowed, isMcpAllowed, isMcpDenied } from "./permissions.js";
export { createGatedMcpTools } from "./mcp.js";

export interface ApprovalRequest {
  readonly action: ToolAction;
  readonly title: string;
  /** Command text (shell) or unified diff (write/edit) shown to the user. */
  readonly preview: string;
  /** Pre-approved (e.g. by the shell allowlist): skips the `ask` prompt, never overrides `deny`. */
  readonly preapproved?: boolean;
  /** Optional subject, used by UI for always-allow; here it's the tool name for MCP tools. */
  readonly subject?: string;
}

/** Outcome of an approval prompt: approved, or denied with an optional reason. */
export type ConfirmResult =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason?: string };

export interface ToolContext {
  readonly workdir: string;
  readonly config: Config;
  /** Called for `ask` policies. A denial's reason is passed back to the model. */
  readonly confirm: (req: ApprovalRequest) => Promise<ConfirmResult>;
  readonly memory?: MemoryStore;
  readonly sessionId?: string;
}

/** Static metadata for each tool (name, action, description) — no context needed. */
export const TOOL_INFO: readonly { name: string; action: ToolAction; description: string }[] = [
  { name: "read_file", action: "read", description: "Read a UTF-8 text file." },
  { name: "list_dir", action: "read", description: "List a directory." },
  { name: "glob", action: "read", description: "Find files by glob pattern." },
  { name: "grep", action: "read", description: "Search file contents by regex." },
  { name: "write_file", action: "write", description: "Create or overwrite a file." },
  { name: "edit_file", action: "edit", description: "Replace a unique string in a file." },
  { name: "run_shell", action: "shell", description: "Run a shell command." },
];

/** Apply the permission policy for an action, then execute (FR-18..FR-22). */
export async function gate(
  ctx: ToolContext,
  req: ApprovalRequest,
  exec: () => string | Promise<string>,
): Promise<string> {
  const policy = resolvePolicy(ctx.config.permissions, req.action);
  if (policy === "deny") {
    return `[denied] "${req.action}" is not allowed in "${ctx.config.permissions.mode}" mode.`;
  }
  if (policy === "ask" && !req.preapproved) {
    const result = await ctx.confirm(req);
    if (!result.approved) {
      // The returned string becomes the tool result the model sees — the
      // reason is its only signal for why, so it can adapt instead of
      // re-proposing the same action (FR-21).
      return result.reason ? `[denied by user — reason: ${result.reason}]` : "[denied by user]";
    }
  }

  // Execute and capture the result; preserve previous behavior for thrown errors.
  const maybe = exec();
  const result = await Promise.resolve(maybe);

  try {
    // Detect genuine failures: starts with "[error]", starts with "[timed out",
    // or contains an exit marker with nonzero code like "[exit 1]".
    const isFailure =
      typeof result === "string" &&
      (result.startsWith("[error]") || result.startsWith("[timed out") || /\[exit ([1-9][0-9]*)\]/.test(result));
    if (isFailure && ctx.memory) {
      try {
        const fp = fingerprintError(result as string);
        ctx.memory.recordFailureEvent({
          ts: new Date().toISOString(),
          sessionId: ctx.sessionId,
          fingerprint: fp,
          errorText: (result as string).slice(0, 2000),
        });
      } catch {
        // swallow any errors from recording — logging must never break a tool
      }
    }
  } catch {
    // swallow any errors during detection/recording (shouldn't happen)
  }

  return result;
}


function friendlyError(err: unknown): string {
  return `[error] ${(err as Error).message ?? String(err)}`;
}

/** Build the LangChain tools for a given context, each wired through the gate. */
export function createTools(ctx: ToolContext): StructuredToolInterface[] {
  const readFile = tool(
    ({ path }) =>
      gate(ctx, { action: "read", title: `Read ${path}`, preview: path }, () => {
        try {
          return readFileWithin(ctx.workdir, path);
        } catch (e) {
          return friendlyError(e);
        }
      }),
    {
      name: "read_file",
      description: "Read a UTF-8 text file within the working directory.",
      schema: z.object({ path: z.string().describe("Path relative to the working directory.") }),
    },
  );

  const listDir = tool(
    ({ path }) =>
      gate(ctx, { action: "read", title: `List ${path}`, preview: path }, () => {
        try {
          return listDirWithin(ctx.workdir, path);
        } catch (e) {
          return friendlyError(e);
        }
      }),
    {
      name: "list_dir",
      description: "List the entries of a directory within the working directory.",
      schema: z.object({ path: z.string().describe("Directory path (use '.' for the root).") }),
    },
  );

  const glob = tool(
    ({ pattern }) =>
      gate(ctx, { action: "read", title: `Glob ${pattern}`, preview: pattern }, () =>
        globWithin(ctx.workdir, pattern).catch(friendlyError),
      ),
    {
      name: "glob",
      description: "Find files matching a glob pattern (e.g. 'src/**/*.ts').",
      schema: z.object({ pattern: z.string().describe("A glob pattern.") }),
    },
  );

  const grep = tool(
    ({ pattern, path }) =>
      gate(ctx, { action: "read", title: `Grep /${pattern}/`, preview: pattern }, () => {
        try {
          const sub = typeof path === "string" && path.trim().length > 0 ? path : undefined;
          return grepWithin(ctx.workdir, pattern, sub);
        } catch (e) {
          return friendlyError(e);
        }
      }),
    {
      name: "grep",
      description: "Search file contents by regular expression, returning file:line: matches.",
      schema: z.object({
        pattern: z.string().describe("A JavaScript regular expression."),
        path: z.string().optional().describe("Optional file or directory to limit the search."),
      }),
    },
  );

  const writeFile = tool(
    ({ path, content }) => {
      let change;
      try {
        change = prepareWrite(ctx.workdir, path, content);
      } catch (e) {
        return Promise.resolve(friendlyError(e));
      }
      return gate(ctx, { action: "write", title: change.summary, preview: change.diff }, () => {
        try {
          change.apply();
          return `Wrote ${path}.`;
        } catch (e) {
          return friendlyError(e);
        }
      });
    },
    {
      name: "write_file",
      description: "Create or overwrite a file. Prompts for approval and shows a diff first.",
      schema: z.object({
        path: z.string().describe("Path relative to the working directory."),
        content: z.string().describe("The full new file contents."),
      }),
    },
  );

  const editFile = tool(
    ({ path, old_string, new_string }) => {
      let change;
      try {
        change = prepareEdit(ctx.workdir, path, old_string, new_string);
      } catch (e) {
        return Promise.resolve(friendlyError(e));
      }
      return gate(ctx, { action: "edit", title: change.summary, preview: change.diff }, () => {
        try {
          change.apply();
          return `Edited ${path}.`;
        } catch (e) {
          return friendlyError(e);
        }
      });
    },
    {
      name: "edit_file",
      description:
        "Replace an exact, unique string in a file with a new string. Fails if old_string is missing or not unique. Prompts for approval and shows a diff first.",
      schema: z.object({
        path: z.string().describe("Path relative to the working directory."),
        old_string: z.string().describe("The exact text to replace (must be unique in the file)."),
        new_string: z.string().describe("The replacement text."),
      }),
    },
  );

  const runShellTool = tool(
    ({ command }) => {
      if (isShellDenied(ctx.config.permissions, command)) {
        return Promise.resolve(
          `[blocked] command matches a denylist pattern and is refused: ${command}`,
        );
      }
      return gate(
        ctx,
        {
          action: "shell",
          title: "Run command",
          preview: command,
          preapproved: isShellAllowed(ctx.config.permissions, command),
        },
        () => runShell(ctx.workdir, command),
      );
    },
    {
      name: "run_shell",
      description: "Run a shell command in the working directory. Prompts for approval first.",
      schema: z.object({ command: z.string().describe("The shell command to run.") }),
    },
  );

  // skill tools: read-only actions that expose installed skills under .cody/skills
  const loadSkill = tool(
    ({ name }) =>
      gate(ctx, { action: "read", title: `Load skill ${name}`, preview: name }, () => {
        try {
          /* ensure skill dir exists and is within workdir */
          resolveWithinWorkdir(ctx.workdir, `.cody/skills/${name}`);
          // read SKILL.md
          const md = readFileWithin(ctx.workdir, `.cody/skills/${name}/SKILL.md`);
          // strip frontmatter
          const body = md.replace(/^---[\s\S]*?---\s*/m, "");
          // list files recursively
          const list = globWithin(ctx.workdir, `.cody/skills/${name}/**/*`).then((out) => {
            const files = out
              .split(/\r?\n/)
              .filter((l) => l && !l.endsWith("/"))
              .map((p) => p.replace(new RegExp(`^${name}/`), ""));
            return `${body}\n\nFiles in this skill:\n${files.join("\n")}`;
          });
          return list.catch(friendlyError);
        } catch (e) {
          return friendlyError(e);
        }
      }),
    {
      name: "load_skill",
      description: "Load an installed skill's SKILL.md body and file list.",
      schema: z.object({ name: z.string().describe("Skill directory name") }),
    },
  );

  const readSkillFile = tool(
    ({ name, path }) =>
      gate(ctx, { action: "read", title: `Read skill ${name}:${path}`, preview: `${name}:${path}` }, () => {
        try {
          const full = `.cody/skills/${name}/${path}`;
          // ensure within
          /* ensure path is within workdir */
          resolveWithinWorkdir(ctx.workdir, full);
          return readFileWithin(ctx.workdir, full);
        } catch (e) {
          return friendlyError(e);
        }
      }),
    {
      name: "read_skill_file",
      description: "Read a file inside an installed skill directory.",
      schema: z.object({ name: z.string().describe("Skill directory name"), path: z.string().describe("Path within the skill dir") }),
    },
  );

  return [readFile, listDir, glob, grep, writeFile, editFile, runShellTool, loadSkill, readSkillFile];
}
