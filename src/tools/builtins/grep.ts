import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

// 默认跳过的目录（对照 ripgrep 默认遵守 .gitignore，这里给 node 回退用）。
const IGNORED_DIRS = new Set([".git", "node_modules", ".sessions", "dist", "build", ".next", "coverage"]);

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents by regular expression across the workspace (ripgrep when available, .gitignore respected). " +
    "Returns matching lines as 'path:line: text'. This is the primary tool for locating code: " +
    "prefer it over reading whole files, and over `grep`/`findstr` via run_command. " +
    "Typical flow: grep to find the file and line, then read_file with offset around that line. " +
    "Narrow with glob (e.g. *.ts) when the pattern is common; escape regex metacharacters when searching literal code like `foo(`.",
  risk: "read",
  concurrencySafe: true,
  maxResultChars: 30000,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search in. Default: workspace root." },
      glob: { type: "string", description: "Only search files matching this glob, e.g. *.ts or **/*.py." },
      ignoreCase: { type: "boolean", description: "Case-insensitive search." },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, description: "Max matching lines (default 100)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { pattern, path: requestedPath = ".", glob, ignoreCase = false, maxResults = 100 } = input as GrepInput;
    const searchRoot = resolveInsideWorkspace(context.cwd, requestedPath);

    const viaRg = await runRipgrep({ pattern, searchRoot, glob, ignoreCase, maxResults, signal: context.signal });
    const lines = viaRg ?? (await runNodeGrep({ pattern, searchRoot, glob, ignoreCase, maxResults }));

    if (lines.length === 0) return `No matches for /${pattern}/ in ${requestedPath}.`;
    const shown = lines.slice(0, maxResults);
    const more = lines.length > shown.length ? `\n…(showing ${shown.length}, more matches truncated)` : "";
    return `${shown.length} match line(s):\n${shown.join("\n")}${more}`;
  },
};

/** 优先用 ripgrep（更快、自动遵守 .gitignore）。rg 不存在则返回 null 走 node 回退。 */
function runRipgrep(opts: {
  pattern: string;
  searchRoot: string;
  glob?: string;
  ignoreCase: boolean;
  maxResults: number;
  signal: AbortSignal;
}): Promise<string[] | null> {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(opts.maxResults)];
  if (opts.ignoreCase) args.push("--ignore-case");
  if (opts.glob) args.push("--glob", opts.glob);
  args.push("--regexp", opts.pattern, "--", opts.searchRoot);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("rg", args, { signal: opts.signal, windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(null); // rg 不在 PATH 上 → 回退
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      // rg 退出码：0 有匹配，1 无匹配，2 出错。
      if (code === 2) {
        resolve(null);
        return;
      }
      const lines = out
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .map((l) => relativizeRgLine(l, opts.searchRoot));
      resolve(lines);
    });
  });
}

/** 把 rg 输出里的绝对路径换成相对搜索根的短路径，便于阅读。 */
function relativizeRgLine(line: string, searchRoot: string): string {
  if (!line.startsWith(searchRoot)) return line;
  return line.slice(searchRoot.length).replace(/^[\\/]/, "");
}

/** 纯 Node 回退：递归遍历、按行正则匹配、跳过二进制与常见忽略目录。 */
async function runNodeGrep(opts: {
  pattern: string;
  searchRoot: string;
  glob?: string;
  ignoreCase: boolean;
  maxResults: number;
}): Promise<string[]> {
  const regex = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
  const globRegex = opts.glob ? globToRegExp(opts.glob) : null;
  const results: string[] = [];

  async function searchFile(full: string, rel: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(full, "utf8");
    } catch {
      return;
    }
    if (isBinaryText(content)) return; // 含 NUL 视为二进制，跳过
    const fileLines = content.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (results.length >= opts.maxResults) return;
      const text = fileLines[i] ?? "";
      if (regex.test(text)) {
        results.push(`${rel}:${i + 1}: ${text.trim()}`);
      }
    }
  }

  async function walk(current: string): Promise<void> {
    if (results.length >= opts.maxResults) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= opts.maxResults) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(opts.searchRoot, full).split(path.sep).join("/");
        if (globRegex && !globRegex.test(rel) && !globRegex.test(entry.name)) continue;
        await searchFile(full, rel);
      }
    }
  }

  const info = await stat(opts.searchRoot).catch(() => null);
  if (info?.isFile()) {
    await searchFile(opts.searchRoot, path.basename(opts.searchRoot));
  } else {
    await walk(opts.searchRoot);
  }
  return results;
}

/** 检测是否为二进制文本（含 NUL 字节）。 */
function isBinaryText(content: string): boolean {
  const limit = Math.min(content.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** 极简 glob → 正则：支持 **、*、?。 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
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
  return new RegExp(`(^|/)${re}$`);
}
