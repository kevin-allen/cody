import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  dir: string;
}

function parseFrontmatter(text?: string): { [k: string]: string | string[] } | null {
  const s = text || "";
  // simple frontmatter parser: expects starts with --- then lines key: value until ---
  if (!s.startsWith("---")) return null;
  const parts = s.split("\n");
  // find second ---
  let end = -1;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const fmLines = parts.slice(1, end);
  const res: { [k: string]: string | string[] } = {};
  for (const l of fmLines) {
    const idx = l.indexOf(":");
    if (idx === -1) continue;
    const key = l.slice(0, idx).trim();
    const val = l.slice(idx + 1).trim();
    if (key === "tags") {
      res[key] = val.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      res[key] = val;
    }
  }
  return res;
}

export function loadSkillsCatalog(cwd: string): SkillMeta[] {
  const base = join(cwd, ".cody", "skills");
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const entry of entries) {
    const skillDir = join(base, entry);
    try {
      const st = statSync(skillDir);
      if (!st.isDirectory()) continue;
      const skillPath = join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = readFileSync(skillPath, "utf8");
      } catch {
        // skip unreadable
        continue;
      }
          const fm = parseFrontmatter(content) ?? {};
      const name = typeof fm.name === "string" ? fm.name : basename(skillDir);
      const description = typeof fm.description === "string" ? fm.description : "";
      const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
      out.push({ name, description, tags, dir: relative(cwd, skillDir) });
    } catch {
      // skip invalid entries
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
