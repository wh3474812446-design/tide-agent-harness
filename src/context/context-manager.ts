import type { Message, ToolResultBlock } from "../types.js";
import { getCompactPrompt, getCompactUserSummaryMessage, messagesToTranscript } from "./compact-prompt.js";

export type CompactMode = "micro" | "summary" | "truncate";

export interface ContextResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** 本次压缩用的方式；未压缩时为 undefined。 */
  mode?: CompactMode;
}

/** 摘要这一轮怎么跑：把转录交给模型，拿回摘要文本。由 agent-loop 注入（持有 provider）。 */
export type Summarizer = (systemPrompt: string, transcript: string) => Promise<string>;

export interface ContextManagerOptions {
  /** 触发压缩的近似 token 阈值。默认 200000（近似值=JSON长度/4；DeepSeek V4 等 1M 窗口模型放得下）。 */
  maxApproxTokens?: number;
  /** 压缩时原样保留的最近消息预算（近似 token）。默认 40000。 */
  keepRecentTokens?: number;
}

/** microcompact 可清理的工具：原始输出大、且事后可重新获取（再读一次/再跑一次）。 */
const MICRO_COMPACTABLE_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "list_files",
  "run_command",
  "get_command_output",
  "web_fetch",
  "web_search",
  "diff",
]);

/** 小于该长度的工具结果不值得清理（清了省不了多少，还丢信息）。 */
const MICRO_MIN_CHARS = 500;

/** microcompact 后若已降到该比例之下，就不再做摘要（留出余量避免下一轮立刻又触发）。 */
const MICRO_SUFFICIENT_RATIO = 0.8;

export class ContextManager {
  readonly #maxApproxTokens: number;
  readonly #keepRecentTokens: number;

  constructor(options: ContextManagerOptions = {}) {
    this.#maxApproxTokens = options.maxApproxTokens ?? 200_000;
    this.#keepRecentTokens = options.keepRecentTokens ?? 40_000;
  }

  /** 是否需要压缩：超过阈值且消息数量足够多（避免压一两条没意义）。 */
  shouldCompact(messages: Message[]): boolean {
    if (messages.length <= 4) return false;
    return this.approximateTokens(messages) > this.#maxApproxTokens;
  }

  /**
   * 两段式压缩（对照 Claude Code 的 microcompact → autoCompact）：
   *
   * 第一段 microcompact：把「最近保留窗口」之外的大块工具结果替换成占位符
   * （文件可以重读、命令可以重跑，旧的原始输出是上下文里最不值钱的部分），
   * 消息结构和所有对话文本原样保留，不需要调模型。足够省出空间就到此为止。
   *
   * 第二段摘要：还不够时，较早部分交给 summarizer 压成一份结构化摘要，
   * 摘要作为开头的用户消息放回。summarizer 失败时退回「截断式」——
   * 保留最近段 + 一句占位，保证压缩永不让整个 run 崩掉。
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
    let older = messages.slice(0, messages.length - recent.length);

    if (older.length === 0) {
      // 没有可压缩的较早部分（最近段已占满预算）：无法压缩，原样返回。
      return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
    }

    // --- 第一段：microcompact，清理较早部分的大块工具结果。---
    const micro = clearOldToolResults(older);
    if (micro.clearedCount > 0) {
      older = micro.messages;
      const candidate = [...older, ...recent];
      const afterMicro = this.approximateTokens(candidate);
      if (afterMicro <= this.#maxApproxTokens * MICRO_SUFFICIENT_RATIO) {
        return { messages: candidate, compacted: true, beforeTokens, afterTokens: afterMicro, mode: "micro" };
      }
    }

    // --- 第二段：摘要式压缩（在 microcompact 之后的较早部分上做，转录更干净）。---
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
      return {
        messages: fallback,
        compacted: true,
        beforeTokens,
        afterTokens: this.approximateTokens(fallback),
        mode: "truncate",
      };
    }

    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: getCompactUserSummaryMessage(summaryText) }],
    };
    const compacted = [summaryMessage, ...recent];
    return {
      messages: compacted,
      compacted: true,
      beforeTokens,
      afterTokens: this.approximateTokens(compacted),
      mode: "summary",
    };
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

/** 把较早消息里可清理的大块工具结果换成占位符；不可变更新，返回清理计数。 */
function clearOldToolResults(messages: Message[]): { messages: Message[]; clearedCount: number } {
  let clearedCount = 0;
  const cleared = messages.map((message) => {
    if (message.role !== "user") return message;
    let touched = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      if (!isMicroCompactable(block) || block.output.length < MICRO_MIN_CHARS) return block;
      touched = true;
      clearedCount += 1;
      const replaced: ToolResultBlock = {
        ...block,
        output: `[旧工具结果已清理以释放上下文（原 ${block.output.length} 字符）。如仍需要，重新调用 ${block.toolName} 即可。]`,
      };
      return replaced;
    });
    return touched ? { ...message, content } : message;
  });
  return { messages: cleared, clearedCount };
}

function isMicroCompactable(block: ToolResultBlock): boolean {
  return MICRO_COMPACTABLE_TOOLS.has(block.toolName) || block.toolName.startsWith("mcp__");
}
