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
import { createSpawnAgentTool } from "../tools/builtins/spawn-agent.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/tool.js";
import { registerMcpServersFromFile, type McpServerStatus } from "../mcp/mcp-manager.js";
import { setupSkills, type SkillManager } from "../skills/index.js";
import { HookRunner, loadHooksConfig } from "../hooks/hooks.js";
import { CheckpointStore } from "../checkpoint/checkpoint.js";
import type { LoadedSkill } from "../skills/skill-loader.js";
import { getModelPreset } from "./model-config.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { ContextManager } from "../context/context-manager.js";
import { createTodoWriteTool, TodoStore } from "../tools/builtins/todo-write.js";
import { FileStateTracker } from "../tools/file-state.js";

export interface TideRuntime {
  agent: AgentLoop;
  events: EventBus;
  tools: ModelToolDefinition[];
  loadedApiTools: number;
  providerName: string;
  allowedRisks: RiskLevel[];
  /** 风险策略对象（CLI 可切换计划模式等）。 */
  policy: RiskPolicy;
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
  /** 检查点存储：CLI 每条消息前 begin()，/rewind 时 rewindLast()。 */
  checkpoints: CheckpointStore;
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
  // Todo 清单工具：需要 events 来把更新同步到网页面板，所以在此注册（非纯内置）。
  // store 同时交给 AgentLoop，用于「清单长期未更新」的 system-reminder。
  const todoStore = new TodoStore();
  registry.register(createTodoWriteTool({ events, store: todoStore }));
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
  // 技能是 Tide 安装级能力（与工作目录无关），默认锚定到安装目录的 skills/，
  // 这样从任意目录用 `tide` 启动、以及网页端，看到的都是同一份技能。
  const skillsDir = process.env.HARNESS_SKILLS_DIR
    ? await resolveConfigPath(process.env.HARNESS_SKILLS_DIR, options.cwd, configRoot)
    : path.join(configRoot, "skills");
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
  // --- Hooks：加载 hooks 配置（PreToolUse/PostToolUse），有规则才挂到执行器上。---
  const hooksFile = process.env.HARNESS_HOOKS_CONFIG ?? "hooks.json";
  const hooksConfig = await loadHooksConfig(await resolveConfigPath(hooksFile, options.cwd, configRoot));
  const hookRunner = new HookRunner(hooksConfig, workspaceRoot);
  const checkpoints = new CheckpointStore();
  // 读后改契约：主代理与所有子代理共享同一个文件状态（同一进程、同一批文件）。
  const fileState = new FileStateTracker();
  // 全局工具超时（毫秒）。run_command / spawn_agent 自带 timeoutMs=0 豁免，自管超时。
  const toolTimeoutMs = positiveIntEnv("HARNESS_TOOL_TIMEOUT_MS", 120_000);
  const executor = new ToolExecutor({
    cwd: workspaceRoot,
    registry,
    policy,
    events,
    hooks: hookRunner.hasAny ? hookRunner : undefined,
    checkpoint: checkpoints,
    fileState,
    timeoutMs: toolTimeoutMs,
  });
  const providerName = modelProviderName();
  const provider = createModelProvider(providerName);
  const sessions = new SessionStore(path.join(options.cwd, ".sessions"));
  // 项目记忆：自动加载工作区里的 CLAUDE.md / AGENTS.md，注入系统提示（对照 Claude Code）。
  const projectContext = await loadProjectContext(workspaceRoot, options.cwd);
  const systemPrompt = buildSystemPrompt(workspaceRoot, skills, projectContext, provider.model ?? null);

  // --- 子代理：用“不含 spawn_agent 的工具子集”构建独立执行器，杜绝递归；注册到主 registry。---
  // general = 全部工具；explore = 只读调研（read / network 风险），调查类子任务用它更安全。
  const childRegistry = new ToolRegistry();
  for (const childTool of registry.list()) childRegistry.register(childTool);
  const exploreRegistry = new ToolRegistry();
  for (const childTool of registry.list()) {
    if (childTool.risk === "read" || childTool.risk === "network") exploreRegistry.register(childTool);
  }
  const childExecutorOptions = {
    cwd: workspaceRoot,
    policy,
    events,
    hooks: hookRunner.hasAny ? hookRunner : undefined,
    checkpoint: checkpoints,
    fileState,
    timeoutMs: toolTimeoutMs,
  };
  const childExecutor = new ToolExecutor({ ...childExecutorOptions, registry: childRegistry });
  const exploreExecutor = new ToolExecutor({ ...childExecutorOptions, registry: exploreRegistry });
  registry.register(
    createSpawnAgentTool({
      provider,
      sessions,
      events,
      systemPrompt,
      general: { registry: childRegistry, executor: childExecutor },
      explore: { registry: exploreRegistry, executor: exploreExecutor },
    }),
  );

  // 上下文管理：两段式压缩（microcompact 清旧工具结果 → 不够再摘要）。预算可用 HARNESS_CONTEXT_TOKENS 调。
  // 默认 200k 近似 token：DeepSeek V4 系列是 1M 窗口，旧默认 48k 只用了零头还频繁触发压缩。
  const context = new ContextManager({
    maxApproxTokens: positiveIntEnv("HARNESS_CONTEXT_TOKENS", 200_000),
    keepRecentTokens: positiveIntEnv("HARNESS_KEEP_RECENT_TOKENS", 40_000),
  });
  const agent = new AgentLoop({
    provider,
    registry,
    executor,
    sessions,
    events,
    context,
    systemPrompt,
    todoStore,
    // 上限调高（旧默认 12/30 会在真实项目中途被掐断）：配合自动压缩，长任务现在能安全跑完。
    maxTurns: positiveIntEnv("HARNESS_MAX_TURNS", 100),
    maxToolCalls: positiveIntEnv("HARNESS_MAX_TOOL_CALLS", 400),
  });

  return {
    agent,
    events,
    tools: registry.definitions(),
    loadedApiTools,
    providerName,
    allowedRisks,
    policy,
    workspaceRoot,
    fsUnrestricted: process.env.HARNESS_FS_UNRESTRICTED === "1",
    mcpServers,
    loadedMcpTools,
    skills,
    skillsDir,
    hasProjectContext: projectContext !== null,
    checkpoints,
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

/** 读取正整数环境变量，非法或缺省回落到 fallback。 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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

function createModelProvider(provider: string): ModelProvider {
  // 单次响应的输出 token 上限。太小会把大文件 write_file 的工具调用 JSON 截断（解析失败）。
  const maxTokens = positiveIntEnv("HARNESS_MAX_OUTPUT_TOKENS", 8192);
  if (provider === "anthropic") {
    const apiKey = requiredEnv("ANTHROPIC_API_KEY", "Anthropic");
    return new AnthropicProvider({
      apiKey,
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
      maxTokens,
    });
  }

  const preset = getModelPreset(provider);
  if (preset) {
    const apiKey = requiredEnv(preset.apiKeyEnv, preset.label);
    return new OpenAICompatibleProvider({
      apiKey,
      baseUrl: process.env[preset.baseUrlEnv] ?? preset.defaultBaseUrl,
      model: process.env[preset.modelEnv] ?? preset.defaultModel,
      maxTokens,
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
