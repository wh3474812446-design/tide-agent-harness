import { readFile } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
  maxChars?: number;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the workspace. Output is prefixed with line numbers (like `cat -n`). " +
    "Use offset/limit to read a slice of a large file. The line-number prefix is for reference only — " +
    "do not include it when editing with replace_in_file.",
  risk: "read",
  concurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1, description: "1-based line to start from (default 1)." },
      limit: { type: "integer", minimum: 1, description: "Max number of lines to read from offset." },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: 200000,
        description: "Char cap as a safety limit (default 50000).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path, offset = 1, limit, maxChars = 50000 } = input as ReadFileInput;
    const content = await readFile(resolveInsideWorkspace(context.cwd, path), "utf8");

    const allLines = content.split("\n");
    const start = offset - 1;
    const end = limit === undefined ? allLines.length : start + limit;
    const slice = allLines.slice(start, end);

    if (slice.length === 0) {
      return `[read_file: 文件共 ${allLines.length} 行，offset=${offset} 超出范围，无内容]`;
    }

    const width = String(start + slice.length).length;
    let numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(width, " ")}\t${line}`)
      .join("\n");

    let note = "";
    if (numbered.length > maxChars) {
      numbered = numbered.slice(0, maxChars);
      note = `\n\n[read_file 已按字符上限截断，可用 offset/limit 继续读取]`;
    } else if (end < allLines.length) {
      note = `\n\n[已显示第 ${offset}-${start + slice.length} 行，共 ${allLines.length} 行]`;
    }

    return `${numbered}${note}`;
  },
};
