import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface GlobInput {
  pattern: string;
  path?: string;
  maxResults?: number;
}

// 遍历时跳过的目录，避免在 node_modules 等大目录里爆炸。
const IGNORED_DIRS = new Set([".git", "node_modules", ".sessions", "dist", "build", ".next", "coverage"]);

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by name pattern (like **/*.ts). Returns matching paths sorted by last-modified time, newest first. " +
    "Use this to locate files when you know part of the name or extension.",
  risk: "read",
  concurrencySafe: true,
  maxResultChars: 20000,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, description: "Glob pattern, e.g. **/*.ts, src/**/*.py, *.md." },
      path: { type: "string", description: "Base directory to search from. Default: workspace root." },
      maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Max paths to return (default 200)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { pattern, path: requestedPath = ".", maxResults = 200 } = input as GlobInput;
    const base = resolveInsideWorkspace(context.cwd, requestedPath);
    const regex = globToRegExp(pattern);

    const matches: { rel: string; mtime: number }[] = [];

    async function walk(current: string): Promise<void> {
      if (matches.length >= maxResults * 4) return; // 软上限，避免遍历过久
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(base, full).split(path.sep).join("/");
          if (!regex.test(rel)) continue;
          try {
            const info = await stat(full);
            matches.push({ rel, mtime: info.mtimeMs });
          } catch {
            matches.push({ rel, mtime: 0 });
          }
        }
      }
    }

    await walk(base);
    if (matches.length === 0) return `No files match ${pattern} under ${requestedPath}.`;
    matches.sort((a, b) => b.mtime - a.mtime);
    const shown = matches.slice(0, maxResults);
    const more = matches.length > shown.length ? `\n…(${matches.length - shown.length} more truncated)` : "";
    return `${shown.length} file(s):\n${shown.map((m) => m.rel).join("\n")}${more}`;
  },
};

/** glob → 正则：支持 **（跨目录）、*（单层）、?。匹配相对路径。 */
function globToRegExp(glob: string): RegExp {
  const normalized = glob.split(path.sep).join("/");
  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i] as string;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        // ** 匹配任意层级目录（含零层），吞掉后续可能的 /
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
