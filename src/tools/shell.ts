import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const TIMEOUT_MS = 60_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function format(code: number, stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  parts.push(`[exit ${code}]`);
  return parts.join("\n");
}

/** Run a shell command in the working directory; never throws (FR-21). */
export async function runShell(workdir: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workdir,
      timeout: TIMEOUT_MS,
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
    if (e.killed) return `[timed out after ${TIMEOUT_MS / 1000}s]`;
    const code = typeof e.code === "number" ? e.code : 1;
    return format(code, e.stdout ?? "", e.stderr ?? e.message ?? "");
  }
}
