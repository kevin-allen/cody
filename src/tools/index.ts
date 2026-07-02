import { tool } from "@langchain/core/tools";
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
import { runShell } from "./shell.js";

export { resolvePolicy, isShellDenied, isShellAllowed } from "./permissions.js";

export interface ApprovalRequest {
  readonly action: ToolAction;
  readonly title: string;
  /** Command text (shell) or unified diff (write/edit) shown to the user. */
  readonly preview: string;
  /** Pre-approved (e.g. by the shell allowlist): skips the `ask` prompt, never overrides `deny`. */
  readonly preapproved?: boolean;
}

export interface ToolContext {
  readonly workdir: string;
  readonly config: Config;
  /** Called for `ask` policies; returns true to proceed. */
  readonly confirm: (req: ApprovalRequest) => Promise<boolean>;
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
  if (policy === "ask" && !req.preapproved && !(await ctx.confirm(req))) {
    return "[denied by user]";
  }
  return exec();
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
          return grepWithin(ctx.workdir, pattern, path);
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

  return [readFile, listDir, glob, grep, writeFile, editFile, runShellTool];
}
