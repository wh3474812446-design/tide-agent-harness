import { exec } from "node:child_process";
import type { Tool } from "../tool.js";
import { startBackgroundCommand } from "./command-jobs.js";

interface RunCommandInput {
  command: string;
  run_in_background?: boolean;
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace. This is a high-risk capability. " +
    "Set run_in_background=true for long-running commands (dev servers, watchers, big installs); " +
    "it returns a job id you can poll with get_command_output instead of blocking.",
  risk: "execute",
  concurrencySafe: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, maxLength: 4000 },
      run_in_background: { type: "boolean", description: "Run detached and return a job id (poll with get_command_output)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { command, run_in_background = false } = input as RunCommandInput;

    if (run_in_background) {
      const job = startBackgroundCommand(command, context.cwd);
      return (
        `后台任务已启动：${job.id}\n命令：${command}\n` +
        `用 get_command_output 传 id="${job.id}" 查看输出与运行状态。`
      );
    }

    // 超时与输出上限可通过环境变量调整：
    //   HARNESS_COMMAND_TIMEOUT_MS：默认 600000（10 分钟），设为 0 表示不限时（适合 npm install / 大克隆）。
    //   HARNESS_COMMAND_MAX_BUFFER：stdout/stderr 字节上限，默认 10MB。
    const timeoutMs = toPositiveInt(process.env.HARNESS_COMMAND_TIMEOUT_MS, 600000);
    const maxBuffer = toPositiveInt(process.env.HARNESS_COMMAND_MAX_BUFFER, 10 * 1024 * 1024);
    return await new Promise<string>((resolve, reject) => {
      exec(
        command,
        {
          cwd: context.cwd,
          signal: context.signal,
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          if (error) {
            reject(new Error(`${error.message}${output ? `\n${output}` : ""}`));
            return;
          }
          resolve(output || "(command completed with no output)");
        },
      );
    });
  },
};

/** 解析非负整数环境变量；非法或缺省时回落到 fallback。0 合法（表示不限时/不限量）。 */
function toPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
