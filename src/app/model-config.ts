import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ModelPreset {
  id: string;
  label: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 该供应商的可选模型列表，网页里作为模型输入框的下拉建议；仍允许手填自定义模型名。 */
  models?: Array<{ id: string; label: string }>;
}

export interface ModelConfigInput {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelEnv: "DEEPSEEK_MODEL",
    defaultBaseUrl: "https://api.deepseek.com",
    // 默认用最新最强的 V4 Pro（deepseek-chat 是旧别名，2026/07/24 下线，仅指向较弱的 v4-flash）。
    defaultModel: "deepseek-v4-pro",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（最强，1.6T/49B，1M 上下文）" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（快而省，284B/13B，1M 上下文）" },
      { id: "deepseek-chat", label: "deepseek-chat（旧别名，→v4-flash，2026/07/24 下线）" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner（旧别名，→v4-flash 思考模式，2026/07/24 下线）" },
    ],
  },
];

export function getModelPreset(provider: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === provider);
}

export function currentModelConfig(): {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
} {
  const provider = (process.env.HARNESS_MODEL_PROVIDER ?? "deepseek").trim().toLowerCase();
  const preset = getModelPreset(provider) ?? getModelPreset("deepseek");
  if (!preset) throw new Error("DeepSeek preset is missing.");
  return {
    provider: preset.id,
    baseUrl: process.env[preset.baseUrlEnv] ?? preset.defaultBaseUrl,
    model: process.env[preset.modelEnv] ?? preset.defaultModel,
    hasApiKey: Boolean(process.env[preset.apiKeyEnv]),
  };
}

export async function saveModelConfig(cwd: string, input: ModelConfigInput): Promise<void> {
  const provider = input.provider.trim().toLowerCase();
  const preset = getModelPreset(provider);
  if (!preset) throw new Error(`不支持的模型供应商：${input.provider}`);
  const nextApiKey = input.apiKey?.trim() || process.env[preset.apiKeyEnv];
  if (!nextApiKey) throw new Error(`请填写 ${preset.label} 的 API Key。`);

  const values: Record<string, string> = {
    HARNESS_MODEL_PROVIDER: preset.id,
    [preset.baseUrlEnv]: input.baseUrl?.trim() || preset.defaultBaseUrl,
    [preset.modelEnv]: input.model?.trim() || preset.defaultModel,
  };
  if (input.apiKey?.trim()) values[preset.apiKeyEnv] = input.apiKey.trim();

  applyEnvValues(values);
  await writeEnvValues(path.join(cwd, ".env"), values);
}

export function applyEnvValues(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

export async function writeEnvValues(filePath: string, values: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const updated = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match?.[2]) return line;
    const key = match[2];
    if (!(key in values)) return line;
    seen.add(key);
    return `${match[1]}${key}${match[3]}${escapeEnvValue(values[key] ?? "")}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) updated.push(`${key}=${escapeEnvValue(value)}`);
  }

  await writeFile(filePath, `${updated.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function escapeEnvValue(value: string): string {
  if (!value || /[\s#"'=]/.test(value)) return JSON.stringify(value);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
