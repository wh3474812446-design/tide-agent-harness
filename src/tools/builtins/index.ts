import { ToolRegistry } from "../tool.js";
import { copyPathTool } from "./copy-path.js";
import { createDirectoryTool } from "./create-directory.js";
import { deletePathTool } from "./delete-path.js";
import { listFilesTool } from "./list-files.js";
import { movePathTool } from "./move-path.js";
import { readFileTool } from "./read-file.js";
import { replaceInFileTool } from "./replace-in-file.js";
import { runCommandTool } from "./run-command.js";
import { writeFileTool } from "./write-file.js";

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    copyPathTool,
    createDirectoryTool,
    deletePathTool,
    listFilesTool,
    movePathTool,
    readFileTool,
    writeFileTool,
    replaceInFileTool,
    runCommandTool,
  ]) {
    registry.register(tool);
  }
  return registry;
}
