import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EventBus } from "../events.js";
import type { JsonSchema, RiskLevel } from "../types.js";
import type { Tool } from "../tools/tool.js";
import { ToolRegistry } from "../tools/tool.js";
import { isStdioServer, loadMcpConfig, type McpServerConfig } from "./mcp-config.js";

/** MCP 工具命名前缀：mcp__<server>__<tool>，与 Claude Code 同款，避免跨服务器重名。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

const MCP_RESULT_MAX_CHARS = 30000;

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
}

export interface McpLoadResult {
  servers: McpServerStatus[];
  registeredTools: number;
  /** 关闭全部 MCP 连接（子进程 / HTTP 会话）。退出前必须调用。 */
  dispose(): Promise<void>;
}

/**
 * 连接 MCP 配置文件里的所有服务器，把它们暴露的工具桥接成 Tide 工具注册进 registry。
 * 单个服务器连接失败不影响其它服务器与整个 harness —— 对照 Claude Code 的 pending client 容错。
 */
export async function registerMcpServersFromFile(
  registry: ToolRegistry,
  filePath: string,
  events: EventBus,
): Promise<McpLoadResult> {
  const config = await loadMcpConfig(filePath);
  const clients: Client[] = [];
  const servers: McpServerStatus[] = [];
  let registeredTools = 0;

  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.disabled) {
      servers.push({ name, ok: false, tools: 0, error: "disabled" });
      continue;
    }
    events.emit({ type: "mcp.connecting", server: name });
    try {
      const client = new Client(
        { name: "tide-harness", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(createTransport(server));
      clients.push(client);

      const { tools } = await client.listTools();
      let count = 0;
      for (const tool of tools) {
        const bridged = createMcpTool(name, server, client, tool);
        if (registry.register(bridged, { skipOnConflict: true })) count += 1;
      }
      registeredTools += count;
      servers.push({ name, ok: true, tools: count });
      events.emit({ type: "mcp.connected", server: name, tools: count });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      servers.push({ name, ok: false, tools: 0, error: message });
      events.emit({ type: "mcp.failed", server: name, error: message });
    }
  }

  return {
    servers,
    registeredTools,
    async dispose() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

function createTransport(server: McpServerConfig): Transport {
  if (isStdioServer(server)) {
    const { command, args } = normalizeStdioCommand(server.command, server.args ?? []);
    return new StdioClientTransport({
      command,
      args,
      env: buildStdioEnv(server.env),
      cwd: server.cwd,
      stderr: "pipe",
    });
  }
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.type === "sse") {
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

/**
 * Windows 上裸命令 `npx` / `npm` / `pnpm` / `yarn` 直接 spawn 会 ENOENT —— 它们是 .cmd 脚本。
 * 这里改用 cmd.exe /c 调用，规避中文 Windows 上最常见的 MCP 启动坑。
 */
function normalizeStdioCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args };
  const bare = command.toLowerCase();
  const needsShell = ["npx", "npm", "pnpm", "yarn", "bunx"].includes(bare);
  if (needsShell) {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/c", command, ...args] };
  }
  return { command, args };
}

/** 把字符串型环境变量传给子进程：合并 PATH 等必要变量，叠加用户在配置里指定的 env。 */
function buildStdioEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

function createMcpTool(
  serverName: string,
  server: McpServerConfig,
  client: Client,
  info: McpToolInfo,
): Tool {
  const readOnly = info.annotations?.readOnlyHint === true;
  const risk: RiskLevel = server.risk ?? (readOnly ? "read" : "execute");
  return {
    name: mcpToolName(serverName, info.name),
    description:
      info.description ?? `MCP tool ${info.name} from server "${serverName}".`,
    inputSchema: normalizeSchema(info.inputSchema),
    risk,
    concurrencySafe: readOnly,
    source: "mcp",
    maxResultChars: MCP_RESULT_MAX_CHARS,
    async execute(input) {
      const result = await client.callTool({
        name: info.name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
      const text = serializeMcpContent(result.content as McpContentBlock[]);
      if (result.isError) throw new Error(text || "MCP tool reported an error.");
      if (result.structuredContent !== undefined && !text) {
        return JSON.stringify(result.structuredContent, null, 2);
      }
      return text || "(MCP tool returned no content)";
    },
  };
}

type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string }
  | { type: "audio"; mimeType: string }
  | { type: "resource"; resource?: { uri?: string } }
  | { type: string; [key: string]: unknown };

function serializeMcpContent(content: McpContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" || block.type === "audio") {
      const mimeType = (block as { mimeType?: string }).mimeType ?? "unknown";
      parts.push(`[${block.type} content: ${mimeType}]`);
    } else if (block.type === "resource") {
      const uri = (block as { resource?: { uri?: string } }).resource?.uri ?? "embedded";
      parts.push(`[resource: ${uri}]`);
    } else {
      parts.push(`[${block.type} content]`);
    }
  }
  return parts.join("\n");
}

/** MCP 工具的 inputSchema 即标准 JSON Schema；缺失时给一个宽松的 object schema。 */
function normalizeSchema(schema: unknown): JsonSchema {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as JsonSchema;
  }
  return { type: "object", additionalProperties: true };
}
