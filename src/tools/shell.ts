import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface ShellOptions {
  /** Kill the command after this many milliseconds (default 60000). */
  readonly timeoutMs?: number;
  /**
   * Hard cap on combined stdout+stderr in characters. 0 disables.
   * The [exit N] marker always survives the cap.
   */
  readonly outputMaxChars?: number;
}

function format(code: number, stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exit ${code}]`);
  return parts.join("\n");
}

/**
 * Truncate a formatted shell result so combined stdout+stderr stays under
 * maxChars, preserving the [exit N] marker at the end so the failure
 * observer and gate detection still work.
 */
function capOutput(result: string, maxChars: number): string {
  if (maxChars <= 0 || result.length <= maxChars) return result;

  // Locate the exit-marker line at the end.
  const exitRe = /\n\[exit \d+\]$/;
  const exitMatch = exitRe.exec(result);
  const exitLine = exitMatch ? exitMatch[0] : "";
  const body = exitMatch ? result.slice(0, -exitLine.length) : result;

  const omitted = body.length;
  const marker = `\n[output truncated: hit the ${maxChars}-char limit — ${omitted} chars omitted; narrow the command's output]`;
  const overhead = marker.length + exitLine.length;

  if (overhead >= maxChars) {
    // Cap is too small even for the markers; just return the markers.
    return marker + exitLine;
  }

  const keepLen = maxChars - overhead;
  const truncated = body.slice(0, keepLen);
  const actualOmitted = body.length - truncated.length;
  const finalMarker = `\n[output truncated: hit the ${maxChars}-char limit — ${actualOmitted} chars omitted; narrow the command's output]`;

  return truncated + finalMarker + exitLine;
}

/** Run a shell command in the working directory; never throws (FR-21). */
export async function runShell(
  workdir: string,
  command: string,
  options: ShellOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result: string;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    result = format(0, stdout, stderr);
  } catch (err) {
    const e = err as {
      code?: number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (e.killed) return `[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    const code = typeof e.code === "number" ? e.code : 1;
    result = format(code, e.stdout ?? "", e.stderr ?? e.message ?? "");
  }
  if (options.outputMaxChars && options.outputMaxChars > 0) {
    return capOutput(result, options.outputMaxChars);
  }
  return result;
}
