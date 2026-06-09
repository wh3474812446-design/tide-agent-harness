import { AgentLoop } from "../../core/agent-loop.js";
import { EventBus } from "../../events.js";
import type { ModelProvider } from "../../model/provider.js";
import type { SessionStore } from "../../session/session-store.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../tool.js";
import type { Tool } from "../tool.js";

interface SpawnAgentInput {
  prompt: string;
  description?: string;
}

interface SpawnAgentDeps {
  provider: ModelProvider;
  /** 子代理可见的工具集（不含 spawn_agent，避免无限递归）。 */
  registry: ToolRegistry;
  /** 用子工具集构建的执行器。 */
  executor: ToolExecutor;
  sessions: SessionStore;
  events: EventBus;
  systemPrompt: string;
}

/**
 * 子代理工具（对照 Claude Code 的 Task/subagent）：把一个独立子任务交给一个全新的
 * AgentLoop 去完成，返回它的最终结论。concurrencySafe=true，所以模型在一轮里发多个
 * spawn_agent 会被执行器并行跑 —— 实现“并行子任务”。子代理看不到 spawn_agent 本身，杜绝递归。
 */
export function createSpawnAgentTool(deps: SpawnAgentDeps): Tool {
  return {
    name: "spawn_agent",
    description:
      "Delegate a focused, self-contained subtask to a fresh sub-agent that has the same tools " +
      "(file/search/command/web) but its own context, and return its result. " +
      "Call it multiple times in one turn to run subtasks in parallel. Give a clear, complete prompt.",
    risk: "read", // 本身不直接改东西；真正的写/执行由子代理内部按策略再审批
    concurrencySafe: true,
    maxResultChars: 12000,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "The full instruction for the sub-agent." },
        description: { type: "string", description: "Short label for this subtask (for logs)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const { prompt, description } = input as SpawnAgentInput;
      const child = new AgentLoop({
        provider: deps.provider,
        registry: deps.registry,
        executor: deps.executor,
        sessions: deps.sessions,
        events: deps.events,
        systemPrompt: `${deps.systemPrompt}\n\n你现在是一个子代理，只需专注完成下面交付的单个子任务，完成后用简洁的中文结论回复（不要反问）。`,
        maxTurns: 8,
        maxToolCalls: 20,
      });
      const result = await child.run(prompt, { signal: context.signal });
      const label = description ? `「${description}」` : "";
      return `子代理${label}完成（${result.turns} 轮，${result.toolCalls} 次工具）：\n\n${result.finalText}`;
    },
  };
}
