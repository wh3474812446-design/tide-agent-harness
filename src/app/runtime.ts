import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "../config/env.js";
import { AgentLoop } from "../core/agent-loop.js";
import { EventBus } from "../events.js";
import { AnthropicProvider } from "../model/anthropic-provider.js";
import { OpenAICompatibleProvider } from "../model/openai-compatible-provider.js";
import type { ModelProvider } from "../model/provider.js";
import { RiskPolicy, type ApprovalHandler } from "../policy/policy.js";
import { SessionStore } from "../session/session-store.js";
import type { ModelToolDefinition, RiskLevel } from "../types.js";
import { registerApiToolsFromFile } from "../tools/api/api-tool.js";
import { createDefaultToolRegistry } from "../tools/builtins/index.js";
import { ToolExecutor } from "../tools/executor.js";
import { registerMcpServersFromFile, type McpServerStatus } from "../mcp/mcp-manager.js";
import { setupSkills, type SkillManager } from "../skills/index.js";
import type { LoadedSkill } from "../skills/skill-loader.js";
import { getModelPreset } from "./model-config.js";

export interface TideRuntime {
  agent: AgentLoop;
  events: EventBus;
  tools: ModelToolDefinition[];
  loadedApiTools: number;
  providerName: string;
  allowedRisks: RiskLevel[];
  workspaceRoot: string;
  fsUnrestricted: boolean;
  /** 已连接的 MCP 服务器状态（含失败原因）。 */
  mcpServers: McpServerStatus[];
  /** 已注册的 MCP 工具总数。 */
  loadedMcpTools: number;
  /** 已加载的技能（启动快照；实时列表用 skillManager.list()）。 */
  skills: LoadedSkill[];
  skillsDir: string;
  /** 是否加载了项目记忆文件（CLAUDE.md / AGENTS.md）。 */
  hasProjectContext: boolean;
  /** 技能管理器：支持运行时 reload（热加载），install 后无需重启。 */
  skillManager?: SkillManager;
  /** 释放资源（关闭 MCP 子进程 / HTTP 会话）。退出前调用。 */
  dispose(): Promise<void>;
}

export async function loadTideEnv(cwd: string): Promise<number> {
  return await loadEnvFile(path.join(cwd, ".env"));
}

export async function createTideRuntime(options: {
  cwd: string;
  events?: EventBus;
  approval?: ApprovalHandler;
  /**
   * 配置文件（api-tools / mcp.json / skills）的回退根目录，默认 = cwd。
   * 用 `tide` 命令从任意目录启动时传入 Tide 安装目录：相对路径的配置先按 cwd 找、
   * 找不到再回退到安装目录，这样安装目录 .env 里的相对路径不会因换目录而失效。
   */
  configRoot?: string;
}): Promise<TideRuntime> {
  const events = options.events ?? new EventBus();
  const registry = createDefaultToolRegistry();
  const configRoot = options.configRoot ? path.resolve(options.configRoot) : options.cwd;
  const apiToolsFile = process.env.HARNESS_API_TOOLS;
  let loadedApiTools = 0;
  if (apiToolsFile) {
    // 加载失败非致命：配置缺失/损坏不该让整个 Tide 崩溃（对照 MCP / 技能的容错）。
    try {
      const resolved = await resolveConfigPath(apiToolsFile, options.cwd, configRoot);
      loadedApiTools = await registerApiToolsFromFile(registry, resolved);
    } catch (error) {
      events.emit({
        type: "mcp.failed",
        server: "api-tools",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 文件工具的工作区根：默认是启动目录，可用 HARNESS_WORKSPACE 改成任意目录（如用户主目录）。
  const workspaceRoot = process.env.HARNESS_WORKSPACE
    ? path.resolve(process.env.HARNESS_WORKSPACE)
    : options.cwd;

  // --- MCP：连接 mcp.json 里配置的服务器，把其工具桥接进 registry（失败非致命）。---
  const mcpConfigPath = await resolveMcpConfigPath(options.cwd, configRoot);
  let mcpServers: McpServerStatus[] = [];
  let loadedMcpTools = 0;
  let disposeMcp: () => Promise<void> = async () => {};
  if (mcpConfigPath) {
    try {
      const result = await registerMcpServersFromFile(registry, mcpConfigPath, events);
      mcpServers = result.servers;
      loadedMcpTools = result.registeredTools;
      disposeMcp = result.dispose;
    } catch (error) {
      events.emit({
        type: "mcp.failed",
        server: path.basename(mcpConfigPath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- 技能：加载 skillsDir，注册 skill / install_skill 工具（失败非致命）。---
  const skillsDir = process.env.HARNESS_SKILLS_DIR
    ? await resolveConfigPath(process.env.HARNESS_SKILLS_DIR, options.cwd, configRoot)
    : path.join(options.cwd, "skills");
  let skills: LoadedSkill[] = [];
  let skillManager: SkillManager | undefined;
  try {
    const result = await setupSkills(registry, { skillsDir, events });
    skills = result.skills;
    skillManager = result.manager;
  } catch (error) {
    events.emit({
      type: "mcp.failed",
      server: "skills",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const allowedRisks = parseAllowedRisks(process.env.HARNESS_ALLOW_RISKS);
  const policy = new RiskPolicy({
    allow: allowedRisks,
    approval: options.approval,
  });
  const executor = new ToolExecutor({ cwd: workspaceRoot, registry, policy, events });
  const providerName = modelProviderName();
  // 项目记忆：自动加载工作区里的 CLAUDE.md / AGENTS.md，注入系统提示（对照 Claude Code）。
  const projectContext = await loadProjectContext(workspaceRoot, options.cwd);
  const agent = new AgentLoop({
    provider: createModelProvider(providerName),
    registry,
    executor,
    sessions: new SessionStore(path.join(options.cwd, ".sessions")),
    events,
    systemPrompt: buildSystemPrompt(workspaceRoot, skills, projectContext),
  });

  return {
    agent,
    events,
    tools: registry.definitions(),
    loadedApiTools,
    providerName,
    allowedRisks,
    workspaceRoot,
    fsUnrestricted: process.env.HARNESS_FS_UNRESTRICTED === "1",
    mcpServers,
    loadedMcpTools,
    skills,
    skillsDir,
    hasProjectContext: projectContext !== null,
    skillManager,
    async dispose() {
      await disposeMcp();
    },
  };
}

/** 解析 MCP 配置路径：优先 HARNESS_MCP_CONFIG（cwd→configRoot 回退），否则自动探测 <cwd>/mcp.json。 */
async function resolveMcpConfigPath(cwd: string, configRoot: string): Promise<string | undefined> {
  const explicit = process.env.HARNESS_MCP_CONFIG;
  if (explicit) return await resolveConfigPath(explicit, cwd, configRoot);
  const auto = path.join(cwd, "mcp.json");
  try {
    await access(auto);
    return auto;
  } catch {
    return undefined;
  }
}

/**
 * 解析配置文件路径：绝对路径直接用；相对路径先按 cwd 找，存在即用，
 * 否则回退到 configRoot（Tide 安装目录）。两处都没有时返回 cwd 解析结果，让上层报清晰错误。
 */
async function resolveConfigPath(relOrAbs: string, cwd: string, configRoot: string): Promise<string> {
  if (path.isAbsolute(relOrAbs)) return relOrAbs;
  const fromCwd = path.resolve(cwd, relOrAbs);
  try {
    await access(fromCwd);
    return fromCwd;
  } catch {
    // cwd 下没有，试安装目录
  }
  const fromConfigRoot = path.resolve(configRoot, relOrAbs);
  try {
    await access(fromConfigRoot);
    return fromConfigRoot;
  } catch {
    return fromCwd;
  }
}

export function parseAllowedRisks(value: string | undefined): RiskLevel[] {
  if (!value) return ["read"];
  const risks: RiskLevel[] = [];
  const validRisks = new Set<RiskLevel>(["read", "write", "execute", "network"]);
  for (const raw of value.split(",")) {
    const risk = raw.trim();
    if (!risk) continue;
    if (!validRisks.has(risk as RiskLevel)) {
      throw new Error(`Invalid risk in HARNESS_ALLOW_RISKS: ${risk}`);
    }
    risks.push(risk as RiskLevel);
  }
  return risks.length > 0 ? risks : ["read"];
}

function modelProviderName(): string {
  return (process.env.HARNESS_MODEL_PROVIDER ?? "deepseek").trim().toLowerCase();
}

/**
 * 加载项目记忆文件，注入系统提示。优先级：工作区 CLAUDE.md > AGENTS.md > 启动目录同名文件。
 * 上限 12000 字符，避免一份超大文档撑爆上下文。
 */
async function loadProjectContext(workspaceRoot: string, cwd: string): Promise<string | null> {
  const candidates = [
    path.join(workspaceRoot, "CLAUDE.md"),
    path.join(workspaceRoot, "AGENTS.md"),
    path.join(cwd, "CLAUDE.md"),
    path.join(cwd, "AGENTS.md"),
  ];
  const seen = new Set<string>();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const content = (await readFile(file, "utf8")).trim();
      if (!content) continue;
      const max = 12000;
      const body = content.length > max ? `${content.slice(0, max)}\n…（已截断）` : content;
      return `（来自 ${path.basename(file)}）\n${body}`;
    } catch {
      // 文件不存在，试下一个
    }
  }
  return null;
}

function buildSystemPrompt(
  workspaceRoot: string,
  skills: LoadedSkill[] = [],
  projectContext: string | null = null,
): string {
  const unrestricted = process.env.HARNESS_FS_UNRESTRICTED === "1";
  const lines = [
    "你是 Tide，一个本地智能体助手。请始终使用简体中文回复。",
    "在调用工具执行任务之前，先用一两句中文简要说明你的计划或思路，让用户知道你在做什么；完成后清晰说明结果。",
    "需要时才调用工具，并遵守当前的风险权限策略。",
    `当前文件工作区根目录是：${workspaceRoot}`,
  ];
  if (unrestricted) {
    lines.push(
      "文件工具已放开整机访问：你可以使用绝对路径在电脑任意位置读写、创建、移动文件或文件夹。",
      `例如桌面通常位于：${workspaceRoot}\\Desktop。在桌面创建文件夹时，请传入完整绝对路径或相对工作区根的路径。`,
      "这是高风险能力，操作前请确认路径正确，避免误删或覆盖用户的重要文件。",
    );
  } else {
    lines.push("文件工具仅限在工作区根目录内操作，超出范围会被拒绝。");
  }
  if (skills.length > 0) {
    lines.push(
      "",
      "你安装了以下技能（skill）。当用户的请求匹配某个技能时，先用 skill 工具加载它的指令，再照做：",
      ...skills.map((s) => `  - ${s.name}：${s.description}`),
    );
  }
  if (projectContext) {
    lines.push(
      "",
      "以下是当前项目的说明文档，请在工作时遵循其中的约定：",
      "----------",
      projectContext,
      "----------",
    );
  }
  return lines.join("\n");
}

function createModelProvider(provider: string): ModelProvider {
  if (provider === "anthropic") {
    const apiKey = requiredEnv("ANTHROPIC_API_KEY", "Anthropic");
    return new AnthropicProvider({
      apiKey,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    });
  }

  const preset = getModelPreset(provider);
  if (preset) {
    const apiKey = requiredEnv(preset.apiKeyEnv, preset.label);
    return new OpenAICompatibleProvider({
      apiKey,
      baseUrl: process.env[preset.baseUrlEnv] ?? preset.defaultBaseUrl,
      model: process.env[preset.modelEnv] ?? preset.defaultModel,
    });
  }

  throw new Error(
    "Invalid HARNESS_MODEL_PROVIDER. Use anthropic, deepseek, qwen, glm, minimax, kimi, mimo, or openai-compatible.",
  );
}

function requiredEnv(name: string, providerLabel: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Set ${name} before running ${providerLabel}. You can put it in .env; copy .env.example to .env first.`,
    );
  }
  return value;
}
