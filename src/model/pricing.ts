import type { TokenUsage } from "../types.js";

/**
 * 估算费用用的价目表（美元 / 每百万 token）。仅作粗略参考，价格随官方调整。
 * 键用模型名前缀模糊匹配；匹配不到则不显示费用。
 */
interface Price {
  input: number; // $ / 1M input tokens
  output: number; // $ / 1M output tokens
}

const PRICES: Array<{ match: RegExp; price: Price }> = [
  // DeepSeek（默认主力，便宜）
  { match: /^deepseek-chat/i, price: { input: 0.27, output: 1.1 } },
  { match: /^deepseek-reasoner/i, price: { input: 0.55, output: 2.19 } },
  { match: /^deepseek/i, price: { input: 0.27, output: 1.1 } },
  // 通义千问
  { match: /^qwen/i, price: { input: 0.4, output: 1.2 } },
  // 智谱 GLM
  { match: /^glm/i, price: { input: 0.6, output: 2.2 } },
  // Kimi / Moonshot
  { match: /^(kimi|moonshot)/i, price: { input: 2.0, output: 5.0 } },
  // MiniMax
  { match: /^(minimax|abab)/i, price: { input: 0.2, output: 1.1 } },
  // Anthropic Claude
  { match: /opus/i, price: { input: 15, output: 75 } },
  { match: /sonnet/i, price: { input: 3, output: 15 } },
  { match: /haiku/i, price: { input: 0.8, output: 4 } },
  // OpenAI（粗略）
  { match: /^gpt-4o-mini/i, price: { input: 0.15, output: 0.6 } },
  { match: /^gpt-4o/i, price: { input: 2.5, output: 10 } },
];

/** 估算费用（美元）。模型不在价目表时返回 undefined。 */
export function estimateCost(model: string, usage: TokenUsage): number | undefined {
  const entry = PRICES.find((p) => p.match.test(model));
  if (!entry) return undefined;
  return (usage.inputTokens / 1_000_000) * entry.price.input + (usage.outputTokens / 1_000_000) * entry.price.output;
}

/** 格式化费用为简短字符串，如 $0.0012。 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(3)}`;
}
