import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "../tool.js";
import { resolveInsideWorkspace } from "./path-utils.js";

interface ReplaceInput {
  path: string;
  search: string;
  replacement: string;
}

export const replaceInFileTool: Tool = {
  name: "replace_in_file",
  description: "Replace exactly one occurrence of text in a UTF-8 file inside the workspace.",
  risk: "write",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      search: { type: "string", minLength: 1 },
      replacement: { type: "string" },
    },
    required: ["path", "search", "replacement"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { path, search, replacement } = input as ReplaceInput;
    const filePath = resolveInsideWorkspace(context.cwd, path);
    const content = await readFile(filePath, "utf8");
    const first = content.indexOf(search);
    const second = content.indexOf(search, first + search.length);
    if (first < 0) throw new Error("Search text was not found.");
    if (second >= 0) throw new Error("Search text occurs more than once; make it more specific.");
    const updated = `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`;
    await writeFile(filePath, updated, "utf8");
    return `Replaced one occurrence in ${path}.`;
  },
};

