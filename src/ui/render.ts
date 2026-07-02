import type { ApprovalRequest } from "../tools/index.js";
import type { SessionMeta } from "../sessions.js";

/**
 * Whether to emit ANSI color: only on a TTY, and never when NO_COLOR is set
 * (its mere presence disables color, per the NO_COLOR convention). FR-37.
 */
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR !== undefined) return false;
  return isTTY;
}

type Style = (s: string) => string;

export interface Palette {
  dim: Style;
  bold: Style;
  cyan: Style;
  green: Style;
  red: Style;
  yellow: Style;
}

function ansi(code: string): Style {
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

export function makePalette(enabled: boolean): Palette {
  const id: Style = (s) => s;
  if (!enabled) return { dim: id, bold: id, cyan: id, green: id, red: id, yellow: id };
  return {
    dim: ansi("2"),
    bold: ansi("1"),
    cyan: ansi("36"),
    green: ansi("32"),
    red: ansi("31"),
    yellow: ansi("33"),
  };
}

/** Interpret a yes/no answer; only an explicit y/yes is affirmative. */
export function isAffirmative(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export type ApprovalAnswer = "yes" | "no" | "always";

/**
 * Interpret a shell-approval answer (FR-22b): y/yes approves once, a/always
 * approves and allowlists the command; anything else declines.
 */
export function parseApprovalAnswer(answer: string): ApprovalAnswer {
  if (isAffirmative(answer)) return "yes";
  if (/^a(lways)?$/i.test(answer.trim())) return "always";
  return "no";
}

/** Color a unified diff line-by-line. */
export function formatDiff(diff: string, p: Palette): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return p.green(line);
      if (line.startsWith("-") && !line.startsWith("---")) return p.red(line);
      if (line.startsWith("@@")) return p.cyan(line);
      return p.dim(line);
    })
    .join("\n");
}

/** Render an approval request (command for shell; colored diff for write/edit). */
export function formatApproval(req: ApprovalRequest, p: Palette): string {
  const header = `${p.yellow("● approval needed")} — ${p.bold(req.title)}`;
  const body = req.action === "shell" ? p.dim("$ ") + req.preview : formatDiff(req.preview, p);
  return `\n${header}\n${body}\n`;
}

export function banner(
  p: Palette,
  version: string,
  mode: string,
  model: string,
  cwd: string,
): string {
  const modeStyle = mode === "auto" ? p.red : p.dim;
  return [
    `${p.bold("cody")} ${p.dim(`v${version}`)}  ${p.dim(model)}  mode: ${modeStyle(mode)}`,
    p.dim(`cwd: ${cwd}`),
    p.dim("Type a request, or /help for commands. Ctrl-C cancels a turn; Ctrl-D exits."),
    "",
  ].join("\n");
}

export function formatSessionList(sessions: SessionMeta[], p: Palette, currentId?: string): string {
  if (!sessions || sessions.length === 0) return "(no sessions)\n";

  // compute pad width for index
  const idxWidth = String(sessions.length).length;

  return sessions
    .map((s, idx) => {
      const index = String(idx + 1).padEnd(idxWidth, " ");
      const marker = s.id === currentId ? "*" : " ";
      const tokens = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
      const preview = s.preview ?? "";
      // id, updatedAt, tokens, preview(dimmed)
      return `${index} ${marker} ${s.id} ${s.updatedAt} ${tokens} ${p.dim(preview)}`;
    })
    .join("\n") + "\n";
}
