import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus, type HarnessEvent } from "./events.js";
import { createTideRuntime, loadTideEnv } from "./app/runtime.js";
import { currentModelConfig, MODEL_PRESETS, saveModelConfig } from "./app/model-config.js";
import { saveWorkspaceConfig } from "./app/workspace-config.js";
import { installSkill } from "./skills/index.js";

interface ChatRequest {
  message?: string;
  sessionId?: string;
}

interface ModelConfigRequest {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface WorkspaceConfigRequest {
  workspace?: string;
  unrestricted?: boolean;
}

const cwd = process.cwd();
const args = new Set(process.argv.slice(2));
const shouldOpen = args.has("--open");
const requestedPort = readPortArg(process.argv.slice(2)) ?? Number(process.env.TIDE_PORT ?? 8787);
const host = process.env.TIDE_HOST ?? "127.0.0.1";
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");

const loadedEnvCount = await loadTideEnv(cwd);
const stateEvents: HarnessEvent[] = [];
const events = new EventBus();
events.subscribe((event) => {
  stateEvents.push(event);
  if (stateEvents.length > 80) stateEvents.shift();
});
let runtime = await createTideRuntime({ cwd, events });

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { error: "缺少请求地址。" });
      return;
    }
    const url = new URL(request.url, `http://${host}`);
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, {
        provider: runtime.providerName,
        modelConfig: currentModelConfig(),
        modelPresets: MODEL_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          defaultBaseUrl: preset.defaultBaseUrl,
          defaultModel: preset.defaultModel,
          models: preset.models ?? [],
        })),
        allowedRisks: runtime.allowedRisks,
        tools: runtime.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        loadedApiTools: runtime.loadedApiTools,
        loadedEnvCount,
        mcp: {
          servers: runtime.mcpServers,
          loadedTools: runtime.loadedMcpTools,
        },
        skills: (runtime.skillManager?.list() ?? runtime.skills).map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
        skillsDir: runtime.skillsDir,
        memoryDir: runtime.memoryDir,
        workspace: {
          root: runtime.workspaceRoot,
          unrestricted: runtime.fsUnrestricted,
          cwd: process.cwd(),
          homeDir: os.homedir(),
        },
        recentEvents: stateEvents.slice(-20),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/model-config") {
      const body = (await readJson(request)) as ModelConfigRequest;
      if (!body.provider) {
        sendJson(response, 400, { error: "请选择模型供应商。" });
        return;
      }
      await saveModelConfig(cwd, {
        provider: body.provider,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        model: body.model,
      });
      await runtime.dispose();
      runtime = await createTideRuntime({ cwd, events });
      sendJson(response, 200, {
        ok: true,
        provider: runtime.providerName,
        modelConfig: currentModelConfig(),
        loadedApiTools: runtime.loadedApiTools,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/workspace") {
      const body = (await readJson(request)) as WorkspaceConfigRequest;
      const saved = await saveWorkspaceConfig(cwd, {
        workspace: body.workspace,
        unrestricted: body.unrestricted,
      });
      await runtime.dispose();
      runtime = await createTideRuntime({ cwd, events });
      sendJson(response, 200, {
        ok: true,
        workspace: {
          root: saved.workspace,
          unrestricted: saved.unrestricted,
          cwd: process.cwd(),
          homeDir: os.homedir(),
        },
        allowedRisks: runtime.allowedRisks,
        tools: runtime.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = (await readJson(request)) as ChatRequest;
      const message = body.message?.trim();
      if (!message) {
        sendJson(response, 400, { error: "请输入消息。" });
        return;
      }
      const before = stateEvents.length;
      const result = await runtime.agent.run(message, { sessionId: body.sessionId });
      sendJson(response, 200, {
        sessionId: result.sessionId,
        finalText: result.finalText,
        reasoning: result.reasoning,
        turns: result.turns,
        toolCalls: result.toolCalls,
        events: stateEvents.slice(before),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/skills/install") {
      const body = (await readJson(request)) as { source?: string; overwrite?: boolean };
      const source = body.source?.trim();
      if (!source) {
        sendJson(response, 400, { error: "请提供技能来源（本地目录或 git URL）。" });
        return;
      }
      if (!runtime.skillManager) {
        sendJson(response, 400, { error: "技能系统未启用。" });
        return;
      }
      // 热加载：安装到磁盘后 reload，技能立即可用，无需重启。
      const result = await installSkill(source, runtime.skillManager.dir, {
        overwrite: body.overwrite === true,
      });
      await runtime.skillManager.reload();
      events.emit({ type: "skill.installed", name: result.name, source: result.source });
      sendJson(response, 200, {
        ok: true,
        installed: result.name,
        overwritten: result.overwritten,
        skills: runtime.skillManager.list().map((s) => ({ name: s.name, description: s.description })),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/reload") {
      // 重建运行时：重新读取 mcp.json 与技能目录、重连 MCP server（MCP 热重载）。
      await runtime.dispose();
      runtime = await createTideRuntime({ cwd, events });
      sendJson(response, 200, {
        ok: true,
        mcp: { servers: runtime.mcpServers, loadedTools: runtime.loadedMcpTools },
        skills: (runtime.skillManager?.list() ?? runtime.skills).map((s) => ({
          name: s.name,
          description: s.description,
        })),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/quit") {
      // 主动退出：回应后让后端进程自行退出（隐藏的后端没有窗口可关，靠这个开关）。
      sendJson(response, 200, { ok: true });
      response.on("finish", () => {
        void runtime.dispose().finally(() => setTimeout(() => process.exit(0), 150));
      });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    sendJson(response, 405, { error: "不支持的请求方法。" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
});

const port = await listenWithFallback(server, host, requestedPort);
const origin = `http://${host}:${port}`;
console.log(`Tide web UI is running at ${origin}`);
console.log("Press Ctrl+C to stop.");
if (shouldOpen) openBrowser(origin);

async function serveStatic(pathname: string, response: http.ServerResponse): Promise<void> {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const target = path.resolve(webRoot, relativePath);
  if (!(target === webRoot || target.startsWith(`${webRoot}${path.sep}`))) {
    sendJson(response, 403, { error: "禁止访问。" });
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    sendJson(response, 404, { error: "没有找到资源。" });
    return;
  }
  if (!info.isFile()) {
    sendJson(response, 404, { error: "没有找到资源。" });
    return;
  }

  response.writeHead(200, {
    "content-type": contentType(target),
    "cache-control": "no-store",
  });
  createReadStream(target).pipe(response);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function listenWithFallback(
  serverToStart: http.Server,
  listenHost: string,
  firstPort: number,
): Promise<number> {
  for (let offset = 0; offset < 20; offset += 1) {
    const port = firstPort + offset;
    try {
      await listen(serverToStart, listenHost, port);
      return port;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No open port found from ${firstPort} to ${firstPort + 19}.`);
}

async function listen(serverToStart: http.Server, listenHost: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(port, listenHost, resolve);
  });
  serverToStart.removeAllListeners("error");
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function readPortArg(values: string[]): number | undefined {
  const index = values.indexOf("--port");
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (!value) throw new Error("--port requires a value.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
