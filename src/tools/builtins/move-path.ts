import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool.js";
import { assertNotWorkspaceRoot, resolveInsideWorkspace } from "./path-utils.js";

interface MovePathInput {
  from: string;
  to: string;
  overwrite?: boolean;
}

export const movePathTool: Tool = {
  name: "move_path",
  description: "Move or rename a file or directory inside the workspace.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { from, to, overwrite = false } = input as MovePathInput;
    const sourcePath = resolveInsideWorkspace(context.cwd, from);
    const destinationPath = resolveInsideWorkspace(context.cwd, to);
    assertNotWorkspaceRoot(context.cwd, sourcePath, "move");

    if (await exists(destinationPath)) {
      if (!overwrite) {
        throw new Error(`Destination already exists: ${to}`);
      }
      assertNotWorkspaceRoot(context.cwd, destinationPath, "overwrite");
      await rm(destinationPath, { recursive: true, force: true });
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await rename(sourcePath, destinationPath);
    return `Moved ${from} to ${to}.`;
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
