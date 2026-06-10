import { lstat, rm } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { assertNotWorkspaceRoot, resolveInsideWorkspace } from "./path-utils.js";

interface DeletePathInput {
  path: string;
  recursive?: boolean;
}

export const deletePathTool: Tool = {
  name: "delete_path",
  description:
    "Delete a file or directory inside the workspace. Directories require recursive=true. " +
    "Directory deletion is destructive and NOT undoable — before deleting anything you did not create yourself, " +
    "inspect it first; it may be the user's in-progress work.",
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

    // 单文件删除可回滚（备份内容）；目录递归删除暂不支持回滚。
    if (!targetStat.isDirectory()) await context.checkpoint?.backup(targetPath);

    await rm(targetPath, { recursive: targetStat.isDirectory(), force: false });
    return `Deleted ${targetStat.isDirectory() ? "directory" : "file"} at ${requestedPath}.`;
  },
};
