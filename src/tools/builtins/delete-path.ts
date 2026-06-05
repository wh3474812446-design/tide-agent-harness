import { lstat, rm } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { assertNotWorkspaceRoot, resolveInsideWorkspace } from "./path-utils.js";

interface DeletePathInput {
  path: string;
  recursive?: boolean;
}

export const deletePathTool: Tool = {
  name: "delete_path",
  description: "Delete a file or directory inside the workspace. Directories require recursive=true.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path: requestedPath, recursive = false } = input as DeletePathInput;
    const targetPath = resolveInsideWorkspace(context.cwd, requestedPath);
    assertNotWorkspaceRoot(context.cwd, targetPath, "delete");

    const targetStat = await lstat(targetPath);
    if (targetStat.isDirectory() && !recursive) {
      throw new Error("Refusing to delete a directory unless recursive is true.");
    }

    await rm(targetPath, { recursive: targetStat.isDirectory(), force: false });
    return `Deleted ${targetStat.isDirectory() ? "directory" : "file"} at ${requestedPath}.`;
  },
};
