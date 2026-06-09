import { readFile } from "node:fs/promises";

/**
 * MCP 服务器配置，形状兼容 Claude Desktop / Cursor 的 `.mcp.json`：
 *   { "mcpServers": { "<name>": { "command": "npx", "args": [...] } } }
 * 也支持远程 HTTP（Streamable HTTP）服务器：
 *   { "mcpServers": { "<name>": { "type": "http", "url": "https://...", "headers": {} } } }
 */
export type McpServerConfig =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      /** 该服务器工具的风险等级（默认 execute——MCP 工具能力未知，保守按高风险）。 */
      risk?: "read" | "write" | "execute" | "network";
      /** 是否禁用此服务器（保留配置但不连接）。 */
      disabled?: boolean;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      risk?: "read" | "write" | "execute" | "network";
      disabled?: boolean;
    };

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export async function loadMcpConfig(filePath: string): Promise<McpConfigFile> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  assertMcpConfig(raw);
  return raw;
}

export function isStdioServer(
  config: McpServerConfig,
): config is Extract<McpServerConfig, { command: string }> {
  return (config.type ?? "stdio") === "stdio";
}

function assertMcpConfig(value: unknown): asserts value is McpConfigFile {
  if (!value || typeof value !== "object" || typeof (value as McpConfigFile).mcpServers !== "object") {
    throw new Error("MCP config must be an object with an mcpServers map.");
  }
  for (const [name, server] of Object.entries((value as McpConfigFile).mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid MCP server name: ${name} (use letters, digits, _ or -).`);
    }
    if (!server || typeof server !== "object") {
      throw new Error(`MCP server ${name} must be an object.`);
    }
    const type = (server as { type?: string }).type ?? "stdio";
    if (type === "stdio") {
      if (typeof (server as { command?: unknown }).command !== "string") {
        throw new Error(`MCP server ${name} requires a string command.`);
      }
    } else if (type === "http" || type === "sse") {
      if (typeof (server as { url?: unknown }).url !== "string") {
        throw new Error(`MCP server ${name} (${type}) requires a string url.`);
      }
    } else {
      throw new Error(`MCP server ${name} has unsupported type: ${type}`);
    }
  }
}
