import { access, copyFile, cp, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { assertNotWorkspaceRoot, resolveInsideWorkspace } from "./path-utils.js";

interface CopyPathInput {
  from: string;
  to: string;
  recursive?: boolean;
  overwrite?: boolean;
}

export const copyPathTool: Tool = {
  name: "copy_path",
  description: "Copy a file or directory inside the workspace. Directories require recursive=true.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      recursive: { type: "boolean" },
      overwrite: { type: "boolean" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { from, to, recursive = false, overwrite = false } = input as CopyPathInput;
    const sourcePath = resolveInsideWorkspace(context.cwd, from);
    const destinationPath = resolveInsideWorkspace(context.cwd, to);
    assertNotWorkspaceRoot(context.cwd, sourcePath, "copy");

    const sourceStat = await lstat(sourcePath);
    const destinationExists = await exists(destinationPath);
    if (destinationExists && !overwrite) {
      throw new Error(`Destination already exists: ${to}`);
    }
    if (destinationExists) {
      assertNotWorkspaceRoot(context.cwd, destinationPath, "overwrite");
    }

    // 回滚备份：仅目标会变（源不动）。
    await context.checkpoint?.backup(destinationPath);

    await mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isDirectory()) {
      if (!recursive) {
        throw new Error("Refusing to copy a directory unless recursive is true.");
      }
      if (destinationExists) {
        await rm(destinationPath, { recursive: true, force: true });
      }
      await cp(sourcePath, destinationPath, { recursive: true, force: overwrite });
      return `Copied directory ${from} to ${to}.`;
    }

    if (destinationExists) {
      await rm(destinationPath, { recursive: true, force: true });
    }
    await copyFile(sourcePath, destinationPath);
    return `Copied file ${from} to ${to}.`;
  },
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
