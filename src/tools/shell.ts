import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface ShellOptions {
  /** Kill the command after this many milliseconds (default 60000). */
  readonly timeoutMs?: number;
}

function format(code: number, stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exit ${code}]`);
  return parts.join("\n");
}

/** Run a shell command in the working directory; never throws (FR-21). */
export async function runShell(
  workdir: string,
  command: string,
  options: ShellOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    return format(0, stdout, stderr);
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
    return format(code, e.stdout ?? "", e.stderr ?? e.message ?? "");
  }
}
