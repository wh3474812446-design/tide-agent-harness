import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { applyReplaceWithCascade, findWithCascade } from "./edit-utils.js";
import { resolveInsideWorkspace } from "./path-utils.js";
import { formatReplaceDiff } from "./diff.js";

interface ReplaceInput {
  path: string;
  search: string;
  replacement: string;
  replace_all?: boolean;
}

export const replaceInFileTool: Tool = {
  name: "replace_in_file",
  description:
    "Replace text in a UTF-8 file. This is the preferred tool for editing existing files (instead of rewriting them with write_file). " +
    "Requirements: (1) You must have read the file with read_file first — edits to unread or externally-modified files are rejected. " +
    "(2) `search` must match the file content exactly and uniquely; include 3-5 lines of surrounding context to make it unique. " +
    "Do NOT include read_file's line-number prefixes in `search`. " +
    "(3) For bulk renames, set replace_all=true to replace every occurrence at once. " +
    "Minor mismatches in trailing whitespace or curly quotes are tolerated automatically, but aim for the exact text.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      search: { type: "string", minLength: 1, description: "Exact existing text (with enough context to be unique)." },
      replacement: { type: "string", description: "New text (must differ from search)." },
      replace_all: { type: "boolean", description: "Replace every occurrence (for renames). Default false: search must be unique." },
    },
    required: ["path", "search", "replacement"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path, search, replacement, replace_all = false } = input as ReplaceInput;
    const filePath = resolveInsideWorkspace(context.cwd, path);

    // 读后改契约：必须读过、且读后未被外部改动。
    if (context.fileState) {
      const violation = await context.fileState.checkBeforeEdit(filePath);
      if (violation) throw new Error(violation);
    }

    const content = await readFile(filePath, "utf8");
    const applied = applyReplaceWithCascade(content, search, replacement, replace_all);

    await context.checkpoint?.backup(filePath);
    await writeFile(filePath, applied.content, "utf8");
    await context.fileState?.recordWrite(filePath);

    const matcherNote = applied.matcher === "exact" ? "" : `（容错匹配：${applied.matcher}）`;
    return replace_all
      ? `Replaced ${applied.replacedCount} occurrence(s) in ${path}.${matcherNote}`
      : `Replaced one occurrence in ${path}.${matcherNote}`;
  },
  async preview(input, context) {
    const { path, search, replacement } = input as ReplaceInput;
    // 尽量用文件里的实际命中文本做 diff（容错匹配时与 search 可能不同）。
    try {
      const filePath = resolveInsideWorkspace(context.cwd, path);
      const content = await readFile(filePath, "utf8");
      const { matches } = findWithCascade(content, search);
      const actual = matches[0]?.actual ?? search;
      return formatReplaceDiff(path, actual, replacement);
    } catch {
      return formatReplaceDiff(path, search, replacement);
    }
  },
};
