import { createTwoFilesPatch } from "diff";

/** A unified diff between two versions of a file, for approval previews (FR-20). */
export function unifiedDiff(path: string, oldStr: string, newStr: string): string {
  return createTwoFilesPatch(path, path, oldStr, newStr, undefined, undefined, { context: 3 });
}
