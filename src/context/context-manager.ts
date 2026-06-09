import type { Message } from "../types.js";
import { getCompactPrompt, getCompactUserSummaryMessage, messagesToTranscript } from "./compact-prompt.js";

export interface ContextResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/** 摘要这一轮怎么跑：把转录交给模型，拿回摘要文本。由 agent-loop 注入（持有 provider）。 */
export type Summarizer = (systemPrompt: string, transcript: string) => Promise<string>;

export interface ContextManagerOptions {
  /** 触发压缩的近似 token 阈值。默认 48000（近似值=JSON长度/4，约等于真实 24~32k tokens，安全落在 64k 窗口内）。 */
  maxApproxTokens?: number;
  /** 压缩时原样保留的最近消息预算（近似 token）。默认 12000。 */
  keepRecentTokens?: number;
}

export class ContextManager {
  readonly #maxApproxTokens: number;
  readonly #keepRecentTokens: number;

  constructor(options: ContextManagerOptions = {}) {
    this.#maxApproxTokens = options.maxApproxTokens ?? 48_000;
    this.#keepRecentTokens = options.keepRecentTokens ?? 12_000;
  }

  /** 是否需要压缩：超过阈值且消息数量足够多（避免压一两条没意义）。 */
  shouldCompact(messages: Message[]): boolean {
    if (messages.length <= 4) return false;
    return this.approximateTokens(messages) > this.#maxApproxTokens;
  }

  /**
   * 摘要式压缩：保留最近一段消息原样，较早的部分交给 summarizer 压成一份结构化摘要，
   * 摘要作为开头的用户消息放回。对照 Claude Code 的 autoCompact：用模型摘要而非直接截断，
   * 这样长链条任务里早期的需求/决策/踩坑不会丢。
   *
   * summarizer 调用失败时（网络/模型问题）退回「截断式」——保留最近段 + 一句占位，
   * 保证压缩永不让整个 run 崩掉。
   */
  async compact(messages: Message[], summarize: Summarizer): Promise<ContextResult> {
    const beforeTokens = this.approximateTokens(messages);

    // 拆出「最近原样保留」的单元（不拆散 tool_call / tool_result 配对）。
    const units = this.#groupWithoutSplittingToolPairs(messages);
    const kept: Message[][] = [];
    let keptTokens = 0;
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index];
      if (!unit) continue;
      const unitTokens = this.approximateTokens(unit);
      if (kept.length > 0 && keptTokens + unitTokens > this.#keepRecentTokens) break;
      kept.unshift(unit);
      keptTokens += unitTokens;
    }
    const recent = kept.flat();
    const older = messages.slice(0, messages.length - recent.length);

    if (older.length === 0) {
      // 没有可摘要的较早部分（最近段已占满预算）：无法压缩，原样返回。
      return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
    }

    let summaryText: string;
    try {
      const transcript = messagesToTranscript(older);
      summaryText = await summarize(getCompactPrompt(), transcript);
    } catch {
      // 摘要失败：退回截断，仅保留最近段 + 占位，绝不让 run 崩。
      const fallback: Message[] = [
        { role: "user", content: [{ type: "text", text: "[Earlier conversation was dropped to free context (summary unavailable).]" }] },
        ...recent,
      ];
      return { messages: fallback, compacted: true, beforeTokens, afterTokens: this.approximateTokens(fallback) };
    }

    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: getCompactUserSummaryMessage(summaryText) }],
    };
    const compacted = [summaryMessage, ...recent];
    return { messages: compacted, compacted: true, beforeTokens, afterTokens: this.approximateTokens(compacted) };
  }

  approximateTokens(messages: Message[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4);
  }

  #groupWithoutSplittingToolPairs(messages: Message[]): Message[][] {
    const units: Message[][] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const current = messages[index];
      const next = messages[index + 1];
      const hasToolCall = current?.content.some((block) => block.type === "tool_call");
      const hasToolResult = next?.content.some((block) => block.type === "tool_result");
      if (current && next && current.role === "assistant" && hasToolCall && hasToolResult) {
        units.push([current, next]);
        index += 1;
      } else if (current) {
        units.push([current]);
      }
    }
    return units;
  }
}
