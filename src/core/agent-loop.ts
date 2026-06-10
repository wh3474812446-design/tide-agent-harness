import { ContextManager } from "../context/context-manager.js";
import { EventBus } from "../events.js";
import type { ModelProvider } from "../model/provider.js";
import type { Session, SessionStore } from "../session/session-store.js";
import type { TodoStore } from "../tools/builtins/todo-write.js";
import type { AgentResult, ContentBlock, Message, TokenUsage, ToolCallBlock } from "../types.js";
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
  /** 可选：todo 状态存储。传入后启用「清单长期未更新」的 system-reminder 注入。 */
  todoStore?: TodoStore;
}

/** 连续多少次工具调用没动过 todo 清单后，注入一次提醒。 */
const TODO_STALE_THRESHOLD = 10;
/** 没建清单时，累计多少次工具调用后提示一次（每个 run 只提示一次）。 */
const TODO_MISSING_THRESHOLD = 15;

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
  readonly #todoStore?: TodoStore;

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
    this.#todoStore = options.todoStore;
  }

  async run(prompt: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<AgentResult> {
    const session = options?.sessionId
      ? await this.#sessions.load(options.sessionId)
      : this.#sessions.create();
    this.#events.emit({ type: "session.started", sessionId: session.id });

    session.messages.push({ role: "user", content: [{ type: "text", text: prompt }] });
    await this.#save(session);

    let toolCalls = 0;
    let lastText = "";
    // system-reminder 注入的计数器（对照 Claude Code：长任务中途持续轻提醒，防止指令稀释）。
    let callsSinceTodoWrite = 0;
    let missingTodoNudged = false;
    const reasoningParts: string[] = [];
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
      // 超预算时先做摘要式压缩，并把压缩结果写回会话（持久化），下一轮在压缩后的历史上继续。
      if (this.#context.shouldCompact(session.messages)) {
        const compacted = await this.#context.compact(session.messages, (systemPrompt, transcript) =>
          this.#summarize(systemPrompt, transcript, options?.signal),
        );
        if (compacted.compacted) {
          session.messages = compacted.messages;
          await this.#save(session);
          this.#events.emit({
            type: "context.compacted",
            before: compacted.beforeTokens,
            after: compacted.afterTokens,
            mode: compacted.mode,
          });
        }
      }

      this.#events.emit({ type: "model.requested", turn });
      const request = {
        systemPrompt: this.#systemPrompt,
        messages: session.messages,
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

      const turnText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (turnText.trim()) lastText = turnText;

      const requestedTools = response.content.filter(
        (block): block is ToolCallBlock => block.type === "tool_call",
      );
      if (requestedTools.length === 0) {
        return this.#finish(session, turnText, reasoningParts, turn, toolCalls, totalUsage);
      }

      toolCalls += requestedTools.length;
      if (toolCalls > this.#maxToolCalls) {
        // 不再抛错丢弃工作：优雅返回已有内容 + 提示（对照 Claude Code 的“达到上限仍给出结果”）。
        const note = `（已达最大工具调用数 ${this.#maxToolCalls}，任务可能未完成。可在 .env 设 HARNESS_MAX_TOOL_CALLS 调高，或把任务拆小、给出更明确的指令重试。）`;
        return this.#finish(session, joinNote(lastText, note), reasoningParts, turn, toolCalls, totalUsage);
      }
      const results = await this.#executor.executeAll(requestedTools, options?.signal);

      // todo 提醒：注意文本块必须放在 tool_result 之后（provider 按「先 tool 后 user」转换）。
      const resultContent: ContentBlock[] = [...results];
      if (this.#todoStore) {
        const touchedTodos = requestedTools.some((call) => call.name === "todo_write");
        callsSinceTodoWrite = touchedTodos ? 0 : callsSinceTodoWrite + requestedTools.length;
        const reminder = this.#todoReminder(callsSinceTodoWrite, toolCalls, missingTodoNudged);
        if (reminder) {
          resultContent.push({ type: "text", text: reminder.text });
          if (reminder.kind === "stale") callsSinceTodoWrite = 0;
          if (reminder.kind === "missing") missingTodoNudged = true;
        }
      }

      session.messages.push({ role: "user", content: resultContent });
      await this.#save(session);
    }

    // 轮数耗尽：同样优雅返回，而不是抛错把整段对话作废。
    const note = `（已达最大对话轮数 ${this.#maxTurns}，任务可能未完成。可在 .env 设 HARNESS_MAX_TURNS 调高，或把任务拆小、给出更明确的指令重试。）`;
    return this.#finish(session, joinNote(lastText, note), reasoningParts, this.#maxTurns, toolCalls, totalUsage);
  }

  /**
   * 生成本轮要注入的 todo 提醒（没有则 null）：
   *  - stale：清单有未完成项，但连续 TODO_STALE_THRESHOLD 次工具调用没更新过 —— 提醒对照清单收口；
   *  - missing：完全没建清单且已累计大量工具调用 —— 提示用 todo_write 外化步骤（每个 run 只提一次）。
   */
  #todoReminder(
    callsSinceTodoWrite: number,
    totalToolCalls: number,
    missingTodoNudged: boolean,
  ): { kind: "stale" | "missing"; text: string } | null {
    if (!this.#todoStore) return null;
    const items = this.#todoStore.get();
    if (items.length > 0 && this.#todoStore.hasIncomplete() && callsSinceTodoWrite >= TODO_STALE_THRESHOLD) {
      const open = items
        .filter((item) => item.status !== "completed")
        .map((item) => `- [${item.status}] ${item.content}`)
        .join("\n");
      return {
        kind: "stale",
        text:
          `<system-reminder>任务清单已连续 ${callsSinceTodoWrite} 次工具调用未更新。当前未完成项：\n${open}\n` +
          `如果某些项其实已完成，立即用 todo_write 标记；如果方向变了，更新清单再继续。不要无视清单闷头跑。</system-reminder>`,
      };
    }
    if (items.length === 0 && totalToolCalls >= TODO_MISSING_THRESHOLD && !missingTodoNudged) {
      return {
        kind: "missing",
        text:
          `<system-reminder>这个任务已经用了 ${totalToolCalls} 次工具但还没有建任务清单。` +
          `如果它是多步骤工作，用 todo_write 把剩余步骤外化成清单，避免漏步或跑偏；如果确实是单步任务，忽略本提醒。</system-reminder>`,
      };
    }
    return null;
  }

  /**
   * 压缩用的摘要调用：不带工具、单轮 complete。把较早对话的转录作为唯一用户消息，
   * 用 CC 的压缩 system prompt 让模型产出结构化摘要。失败由 ContextManager 兜底回退。
   */
  async #summarize(systemPrompt: string, transcript: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#provider.complete({
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
      tools: [],
      signal,
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Empty summary from model.");
    return text;
  }

  /** 统一构建返回结果并发 agent.finished 事件。 */
  #finish(
    session: Session,
    finalText: string,
    reasoningParts: string[],
    turns: number,
    toolCalls: number,
    usage: TokenUsage,
  ): AgentResult {
    this.#events.emit({
      type: "agent.finished",
      turns,
      toolCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return {
      sessionId: session.id,
      finalText,
      reasoning: reasoningParts.join("\n\n") || undefined,
      turns,
      toolCalls,
      messages: session.messages,
      usage,
      costUsd: this.#provider.model ? estimateCost(this.#provider.model, usage) : undefined,
    };
  }

  async #save(session: Session): Promise<void> {
    await this.#sessions.save(session);
    this.#events.emit({ type: "session.saved", sessionId: session.id });
  }
}

/** 把已有文本和上限提示拼起来；没有已有文本时只返回提示。 */
function joinNote(text: string, note: string): string {
  return text.trim() ? `${text}\n\n${note}` : note;
}
