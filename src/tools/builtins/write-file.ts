import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";
import { formatWriteDiff } from "./diff.js";

interface WriteFileInput {
  path: string;
  content: string;
}

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write a UTF-8 file inside the workspace, replacing any existing content.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", maxLength: 500000 },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path: requestedPath, content } = input as WriteFileInput;
    const filePath = resolveInsideWorkspace(context.cwd, requestedPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `Wrote ${content.length} characters to ${requestedPath}.`;
  },
  async preview(input, context) {
    const { path: requestedPath, content } = input as WriteFileInput;
    const filePath = resolveInsideWorkspace(context.cwd, requestedPath);
    const existing = await readFile(filePath, "utf8").catch(() => null);
    return formatWriteDiff(requestedPath, existing, content);
  },
};

