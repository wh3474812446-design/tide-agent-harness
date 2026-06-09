import { ContextManager } from "../context/context-manager.js";
import { EventBus } from "../events.js";
import type { ModelProvider } from "../model/provider.js";
import type { Session, SessionStore } from "../session/session-store.js";
import type { AgentResult, Message, TokenUsage, ToolCallBlock } from "../types.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/tool.js";
import { estimateCost } from "../model/pricing.js";

interface AgentLoopOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  executor: ToolExecutor;
  sessions: SessionStore;
  context?: ContextManager;
  events?: EventBus;
  systemPrompt?: string;
  maxTurns?: number;
  maxToolCalls?: number;
}

export class AgentLoop {
  readonly #provider: ModelProvider;
  readonly #registry: ToolRegistry;
  readonly #executor: ToolExecutor;
  readonly #sessions: SessionStore;
  readonly #context: ContextManager;
  readonly #events: EventBus;
  readonly #systemPrompt: string;
  readonly #maxTurns: number;
  readonly #maxToolCalls: number;

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.#executor = options.executor;
    this.#sessions = options.sessions;
    this.#context = options.context ?? new ContextManager();
    this.#events = options.events ?? new EventBus();
    this.#systemPrompt =
      options.systemPrompt ??
      "You are Tide, a careful local agent harness assistant. Use tools when needed, respect the configured risk policy, and explain final results clearly.";
    this.#maxTurns = options.maxTurns ?? 12;
    this.#maxToolCalls = options.maxToolCalls ?? 30;
  }

  async run(prompt: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<AgentResult> {
    const session = options?.sessionId
      ? await this.#sessions.load(options.sessionId)
      : this.#sessions.create();
    this.#events.emit({ type: "session.started", sessionId: session.id });

    session.messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
    await this.#save(session);

    let toolCalls = 0;
    const reasoningParts: string[] = [];
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      const context = this.#context.prepare(session.messages);
      if (context.compacted) {
        this.#events.emit({
          type: "context.compacted",
          before: context.beforeTokens,
          after: context.afterTokens,
        });
      }

      this.#events.emit({ type: "model.requested", turn });
      const request = {
        systemPrompt: this.#systemPrompt,
        messages: context.messages,
        tools: this.#registry.definitions(),
        signal: options?.signal,
      };
      // 有流式接口就用流式（边收边发 model.delta 事件），否则退回一次性 complete。
      const response = this.#provider.stream
        ? await this.#provider.stream(request, {
            onText: (delta) => this.#events.emit({ type: "model.delta", turn, text: delta }),
          })
        : await this.#provider.complete(request);
      this.#events.emit({ type: "model.responded", turn, stopReason: response.stopReason });

      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;
      totalUsage.inputTokens += inputTokens;
      totalUsage.outputTokens += outputTokens;
      this.#events.emit({ type: "model.usage", turn, inputTokens, outputTokens });
      if (response.reasoning) reasoningParts.push(response.reasoning);

      const assistantMessage: Message = { role: "assistant", content: response.content };
      session.messages.push(assistantMessage);
      await this.#save(session);

      const requestedTools = response.content.filter(
        (block): block is ToolCallBlock => block.type === "tool_call",
      );
      if (requestedTools.length === 0) {
        const finalText = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        this.#events.emit({
          type: "agent.finished",
          turns: turn,
          toolCalls,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
        });
        return {
          sessionId: session.id,
          finalText,
          reasoning: reasoningParts.join("\n\n") || undefined,
          turns: turn,
          toolCalls,
          messages: session.messages,
          usage: totalUsage,
          costUsd: this.#provider.model ? estimateCost(this.#provider.model, totalUsage) : undefined,
        };
      }

      toolCalls += requestedTools.length;
      if (toolCalls > this.#maxToolCalls) {
        throw new Error(`Maximum tool call count exceeded: ${this.#maxToolCalls}`);
      }
      const results = await this.#executor.executeAll(requestedTools, options?.signal);
      session.messages.push({ role: "user", content: results });
      await this.#save(session);
    }

    throw new Error(`Maximum turn count exceeded: ${this.#maxTurns}`);
  }

  async #save(session: Session): Promise<void> {
    await this.#sessions.save(session);
    this.#events.emit({ type: "session.saved", sessionId: session.id });
  }
}
