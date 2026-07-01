import { resolve, relative, isAbsolute, sep } from "node:path";

export class PathError extends Error {}

/**
 * Resolve `p` against `workdir`, rejecting anything that escapes it (FR-12).
 * Always enforced, regardless of permission mode (AC-4).
 *
 * Note: this catches `..`, absolute paths, and traversal. It does not follow
 * symlinks — a symlink inside the workdir that points outside is a known gap,
 * deferred to a later hardening pass.
 */
export function resolveWithinWorkdir(workdir: string, p: string): string {
  const base = resolve(workdir);
  const abs = resolve(base, p);
  const rel = relative(base, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathError(`Path "${p}" escapes the working directory.`);
  }
  return abs;
}
