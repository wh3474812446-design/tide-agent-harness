import type { Message } from "../types.js";

export interface ContextResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

export class ContextManager {
  readonly #maxApproxTokens: number;

  constructor(maxApproxTokens = 12000) {
    this.#maxApproxTokens = maxApproxTokens;
  }

  prepare(messages: Message[]): ContextResult {
    const beforeTokens = this.approximateTokens(messages);
    if (beforeTokens <= this.#maxApproxTokens || messages.length <= 3) {
      return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
    }

    const first = messages[0];
    if (!first) return { messages, compacted: false, beforeTokens, afterTokens: beforeTokens };

    const marker: Message = {
      role: "user",
      content: [{ type: "text", text: "[Earlier conversation compacted by the harness.]" }],
    };
    const units = this.#groupWithoutSplittingToolPairs(messages.slice(1));
    const kept: Message[][] = [];
    let estimate = this.approximateTokens([first, marker]);

    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index];
      if (!unit) continue;
      const unitTokens = this.approximateTokens(unit);
      if (kept.length > 0 && estimate + unitTokens > this.#maxApproxTokens) break;
      kept.unshift(unit);
      estimate += unitTokens;
    }

    const compacted = [first, marker, ...kept.flat()];
    return {
      messages: compacted,
      compacted: true,
      beforeTokens,
      afterTokens: this.approximateTokens(compacted),
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

