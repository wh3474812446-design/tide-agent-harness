import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface ListFilesInput {
  path?: string;
}

export const listFilesTool: Tool = {
  name: "list_files",
  description: "List files and directories at a path inside the workspace.",
  risk: "read",
  concurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the workspace." } },
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path: requestedPath = "." } = input as ListFilesInput;
    const directory = resolveInsideWorkspace(context.cwd, requestedPath);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${path.join(requestedPath, entry.name)}`)
      .join("\n");
  },
};

