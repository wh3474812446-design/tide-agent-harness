import { readFile } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface ReadFileInput {
  path: string;
  maxChars?: number;
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  risk: "read",
  concurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      maxChars: { type: "integer", minimum: 1, maximum: 200000 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path, maxChars = 50000 } = input as ReadFileInput;
    const content = await readFile(resolveInsideWorkspace(context.cwd, path), "utf8");
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n\n[read_file truncated ${content.length - maxChars} characters]`;
  },
};

