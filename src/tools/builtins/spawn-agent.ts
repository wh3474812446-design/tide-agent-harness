import { AgentLoop } from "../../core/agent-loop.js";
import { EventBus } from "../../events.js";
import type { ModelProvider } from "../../model/provider.js";
import type { SessionStore } from "../../session/session-store.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../tool.js";
import type { Tool } from "../tool.js";

type AgentType = "general" | "explore";

interface SpawnAgentInput {
  prompt: string;
  description?: string;
  agent_type?: AgentType;
}

interface AgentKit {
  /** 子代理可见的工具集（不含 spawn_agent，避免无限递归）。 */
  registry: ToolRegistry;
  /** 用该工具集构建的执行器。 */
  executor: ToolExecutor;
}

interface SpawnAgentDeps {
  provider: ModelProvider;
  sessions: SessionStore;
  events: EventBus;
  systemPrompt: string;
  /** 全工具子代理。 */
  general: AgentKit;
  /** 只读调研子代理（只有 read / network 风险的工具）。 */
  explore: AgentKit;
}

const EXPLORE_SUFFIX =
  "你现在是一个只读调研子代理（explore）：只用读取/搜索/联网类工具调查问题，不修改任何文件、不执行带副作用的命令。" +
  "把发现整理成简洁、信息密度高的中文结论汇报（包含关键文件路径与行号），不要反问。";
const GENERAL_SUFFIX =
  "你现在是一个子代理，只需专注完成下面交付的单个子任务，完成后用简洁的中文结论汇报（不要反问）。";

/**
 * 子代理工具（对照 Claude Code 的 Task/subagent）：把一个独立子任务交给一个全新的
 * AgentLoop 去完成，返回它的最终结论。concurrencySafe=true，所以模型在一轮里发多个
 * spawn_agent 会被执行器并行跑 —— 实现“并行子任务”。子代理看不到 spawn_agent 本身，杜绝递归。
 * 预算默认 40 轮 / 120 次工具调用（可用 HARNESS_SUBAGENT_MAX_TURNS / _MAX_TOOL_CALLS 调），
 * 足够装下大仓库的调研或一个完整子功能的实现。
 */
export function createSpawnAgentTool(deps: SpawnAgentDeps): Tool {
  return {
    name: "spawn_agent",
    description:
      "Delegate a focused, self-contained subtask to a fresh sub-agent with its own context window, and get back its final report. " +
      "Use it when a subtask would flood your context with raw output: broad codebase exploration, multi-file research, or an isolated implementation step. " +
      'Set agent_type="explore" for read-only research (it can read/search/fetch but cannot modify anything) — prefer it for investigation; ' +
      'use agent_type="general" (default) when the subtask must edit files or run commands. ' +
      "The sub-agent only sees your prompt — make it complete and specific (goal, relevant paths, what to return). " +
      "Call spawn_agent multiple times in one turn to run independent subtasks in parallel. Not for trivial lookups you can do yourself in 1-2 calls.",
    risk: "read", // 本身不直接改东西；真正的写/执行由子代理内部按策略再审批
    concurrencySafe: true,
    // 子代理一跑几十轮，远超执行器全局工具超时；由子循环自身的轮数/调用数上限收口。
    timeoutMs: 0,
    maxResultChars: 12000,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "The full instruction for the sub-agent (goal, context paths, expected output)." },
        description: { type: "string", description: "Short label for this subtask (for logs)." },
        agent_type: {
          type: "string",
          enum: ["general", "explore"],
          description: 'explore = read-only research agent; general (default) = full tools.',
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const { prompt, description, agent_type = "general" } = input as SpawnAgentInput;
      const kit = agent_type === "explore" ? deps.explore : deps.general;
      const suffix = agent_type === "explore" ? EXPLORE_SUFFIX : GENERAL_SUFFIX;
      const child = new AgentLoop({
        provider: deps.provider,
        registry: kit.registry,
        executor: kit.executor,
        sessions: deps.sessions,
        events: deps.events,
        systemPrompt: `${deps.systemPrompt}\n\n${suffix}`,
        maxTurns: envInt("HARNESS_SUBAGENT_MAX_TURNS", 40),
        maxToolCalls: envInt("HARNESS_SUBAGENT_MAX_TOOL_CALLS", 120),
      });
      const result = await child.run(prompt, { signal: context.signal });
      const label = description ? `「${description}」` : "";
      return `子代理${label}完成（${agent_type}，${result.turns} 轮，${result.toolCalls} 次工具）：\n\n${result.finalText}`;
    },
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
