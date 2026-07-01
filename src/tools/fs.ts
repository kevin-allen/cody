import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import fg from "fast-glob";
import { resolveWithinWorkdir } from "./paths.js";
import { unifiedDiff } from "./diff.js";

const MAX_READ_BYTES = 200_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);
const GREP_LIMIT = 200;

/** A prepared, not-yet-applied file change: its diff preview and an apply(). */
export interface Change {
  readonly summary: string;
  readonly diff: string;
  apply(): void;
}

export function readFileWithin(workdir: string, path: string): string {
  const abs = resolveWithinWorkdir(workdir, path);
  const data = readFileSync(abs, "utf8");
  return data.length > MAX_READ_BYTES
    ? `${data.slice(0, MAX_READ_BYTES)}\n… [truncated at ${MAX_READ_BYTES} chars]`
    : data;
}

export function listDirWithin(workdir: string, path: string): string {
  const abs = resolveWithinWorkdir(workdir, path);
  const entries = readdirSync(abs, { withFileTypes: true });
  const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  return names.length ? names.join("\n") : "(empty)";
}

export async function globWithin(workdir: string, pattern: string): Promise<string> {
  const matches = await fg(pattern, {
    cwd: workdir,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [...IGNORED_DIRS].map((d) => `**/${d}/**`),
  });
  const safe = matches.filter((m) => {
    try {
      resolveWithinWorkdir(workdir, m);
      return true;
    } catch {
      return false;
    }
  });
  return safe.length ? safe.sort().join("\n") : "(no matches)";
}

export function grepWithin(workdir: string, pattern: string, sub?: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `[error] invalid regex: ${(err as Error).message}`;
  }

  const root = resolveWithinWorkdir(workdir, sub ?? ".");
  const results: string[] = [];

  const grepFile = (full: string): void => {
    let content: string;
    try {
      if (statSync(full).size > MAX_READ_BYTES) return;
      content = readFileSync(full, "utf8");
    } catch {
      return;
    }
    const rel = relative(workdir, full);
    for (const [i, line] of content.split("\n").entries()) {
      if (re.test(line)) {
        results.push(`${rel}:${i + 1}:${line.trim()}`);
        if (results.length >= GREP_LIMIT) return;
      }
    }
  };

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= GREP_LIMIT) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        grepFile(full);
      }
    }
  };

  if (statSync(root).isFile()) grepFile(root);
  else walk(root);

  return results.length ? results.join("\n") : "(no matches)";
}

export function prepareWrite(workdir: string, path: string, content: string): Change {
  const abs = resolveWithinWorkdir(workdir, path);
  let oldContent = "";
  let existed = false;
  try {
    oldContent = readFileSync(abs, "utf8");
    existed = true;
  } catch {
    // new file
  }
  const rel = relative(workdir, abs) || path;
  return {
    summary: existed ? `Overwrite ${rel}` : `Create ${rel}`,
    diff: unifiedDiff(rel, oldContent, content),
    apply() {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
  };
}

export function prepareEdit(
  workdir: string,
  path: string,
  oldString: string,
  newString: string,
): Change {
  if (oldString.length === 0) {
    throw new Error("edit_file: old_string must not be empty.");
  }
  const abs = resolveWithinWorkdir(workdir, path);
  const content = readFileSync(abs, "utf8");
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`edit_file: old_string was not found in ${path}.`);
  }
  if (occurrences > 1) {
    throw new Error(
      `edit_file: old_string occurs ${occurrences} times in ${path}; it must be unique.`,
    );
  }
  const updated = content.replace(oldString, newString);
  const rel = relative(workdir, abs) || path;
  return {
    summary: `Edit ${rel}`,
    diff: unifiedDiff(rel, content, updated),
    apply() {
      writeFileSync(abs, updated, "utf8");
    },
  };
}
