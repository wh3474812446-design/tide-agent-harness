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
  description:
    "Create a new UTF-8 file, or fully overwrite an existing one. Parent directories are created automatically. " +
    "Overwriting an existing file requires that you have read it with read_file first (and that it was not modified since) — " +
    "this protects against blindly destroying content. For partial changes to an existing file, prefer replace_in_file. " +
    "Do not create files that aren't necessary for the task; prefer editing existing files.",
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
    // 读后改契约：覆盖已存在的文件前必须读过最新内容；新建文件不受限。
    if (context.fileState) {
      const violation = await context.fileState.checkBeforeEdit(filePath);
      if (violation) throw new Error(violation);
    }
    await context.checkpoint?.backup(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    await context.fileState?.recordWrite(filePath);
    return `Wrote ${content.length} characters to ${requestedPath}.`;
  },
  async preview(input, context) {
    const { path: requestedPath, content } = input as WriteFileInput;
    const filePath = resolveInsideWorkspace(context.cwd, requestedPath);
    const existing = await readFile(filePath, "utf8").catch(() => null);
    return formatWriteDiff(requestedPath, existing, content);
  },
};

