import { mkdir } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface CreateDirectoryInput {
  path: string;
}

export const createDirectoryTool: Tool = {
  name: "create_directory",
  description: "Create a directory inside the workspace, including missing parent directories.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path: requestedPath } = input as CreateDirectoryInput;
    const directoryPath = resolveInsideWorkspace(context.cwd, requestedPath);
    await mkdir(directoryPath, { recursive: true });
    return `Created directory at ${requestedPath}.`;
  },
};
