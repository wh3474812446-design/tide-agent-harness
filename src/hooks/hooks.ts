import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Hooks（自动化规则），对照 Claude Code 的 PreToolUse / PostToolUse：
 * 在工具执行前后跑 shell 命令。PreToolUse 命令以非零退出码结束时可拦截该工具调用。
 *
 * 配置示例 hooks.json：
 * {
 *   "PreToolUse":  [{ "matcher": "run_command", "command": "echo blocked && exit 1" }],
 *   "PostToolUse": [{ "matcher": "write_file|replace_in_file", "command": "npm run lint --silent" }]
 * }
 * matcher 是匹配工具名的正则字符串；省略或 "*" 表示匹配所有工具。
 */
export interface HookRule {
  matcher?: string;
  command: string;
}

export interface HooksConfig {
  PreToolUse?: HookRule[];
  PostToolUse?: HookRule[];
}

export interface PreToolResult {
  block: boolean;
  reason?: string;
}

export class HookRunner {
  readonly #config: HooksConfig;
  readonly #cwd: string;
  readonly #timeoutMs: number;

  constructor(config: HooksConfig, cwd: string, timeoutMs = 60000) {
    this.#config = config;
    this.#cwd = cwd;
    this.#timeoutMs = timeoutMs;
  }

  get hasAny(): boolean {
    return (this.#config.PreToolUse?.length ?? 0) + (this.#config.PostToolUse?.length ?? 0) > 0;
  }

  /** 工具执行前：任一匹配的 PreToolUse 命令非零退出 → 拦截。 */
  async runPreToolUse(toolName: string, input: unknown): Promise<PreToolResult> {
    for (const rule of this.#matching(this.#config.PreToolUse, toolName)) {
      const { code, output } = await this.#run(rule.command, {
        TIDE_TOOL_NAME: toolName,
        TIDE_TOOL_INPUT: safeJson(input),
      });
      if (code !== 0) {
        return { block: true, reason: `PreToolUse hook 拦截了 ${toolName}（退出码 ${code}）：${output.trim() || rule.command}` };
      }
    }
    return { block: false };
  }

  /** 工具执行后：跑所有匹配的 PostToolUse 命令（非阻塞语义，失败只记录不影响结果）。 */
  async runPostToolUse(toolName: string, input: unknown, output: string): Promise<void> {
    for (const rule of this.#matching(this.#config.PostToolUse, toolName)) {
      await this.#run(rule.command, {
        TIDE_TOOL_NAME: toolName,
        TIDE_TOOL_INPUT: safeJson(input),
        TIDE_TOOL_OUTPUT: output.slice(0, 4000),
      });
    }
  }

  #matching(rules: HookRule[] | undefined, toolName: string): HookRule[] {
    if (!rules) return [];
    return rules.filter((r) => {
      if (!r.matcher || r.matcher === "*") return true;
      try {
        return new RegExp(r.matcher).test(toolName);
      } catch {
        return r.matcher === toolName;
      }
    });
  }

  #run(command: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      exec(
        command,
        { cwd: this.#cwd, timeout: this.#timeoutMs, windowsHide: true, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join("\n");
          const code = error && typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
          resolve({ code, output });
        },
      );
    });
  }
}

/** 从文件加载 hooks 配置；不存在或无效则返回空配置。 */
export async function loadHooksConfig(filePath: string): Promise<HooksConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as HooksConfig;
    return {
      PreToolUse: Array.isArray(parsed.PreToolUse) ? parsed.PreToolUse : [],
      PostToolUse: Array.isArray(parsed.PostToolUse) ? parsed.PostToolUse : [],
    };
  } catch {
    return {};
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
