import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import type { Tool } from "../tool.js";
import { startBackgroundCommand } from "./command-jobs.js";

interface RunCommandInput {
  command: string;
  run_in_background?: boolean;
}

/**
 * 跨调用持久的工作目录（对照 Claude Code 的持久 shell：cd 在多次调用间延续）。
 * 实现：在命令末尾追加哨兵，命令成功后打印结束时的 cwd，下次调用从那里启动。
 * 命令失败（&& 短路）或解析不到哨兵时不更新，回退到工作区根；目录被删同样回退。
 * 进程内状态，随 Tide 退出而重置。
 */
let persistentCwd: string | null = null;

export function resetCommandCwd(): void {
  persistentCwd = null;
}

const CWD_MARKER = "__TIDE_CWD__";

/** 给命令追加打印 cwd 的哨兵。命令以 & | ; 结尾（如后台符）时不追加，避免拼出语法错误。 */
function withCwdSentinel(command: string): { command: string; hasSentinel: boolean } {
  if (/[&|;]\s*$/.test(command)) return { command, hasSentinel: false };
  const suffix =
    process.platform === "win32"
      ? ` && echo ${CWD_MARKER}&& cd` // cmd：echo 哨兵行，bare `cd` 打印当前目录（%CD% 会被提前展开，不能用）
      : ` && printf '${CWD_MARKER}\\n%s\\n' "$PWD"`;
  return { command: `${command}${suffix}`, hasSentinel: true };
}

/** 从输出里取出哨兵行与其后的 cwd 行；返回剥掉哨兵后的输出。 */
function extractCwd(output: string): { output: string; cwd: string | null } {
  const markerIndex = output.lastIndexOf(CWD_MARKER);
  if (markerIndex < 0) return { output, cwd: null };
  const tail = output.slice(markerIndex + CWD_MARKER.length);
  const cwd = tail.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  const cleaned = output.slice(0, markerIndex).replace(/\r?\n$/, "");
  return { output: cleaned, cwd };
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace (cmd.exe on Windows, /bin/sh elsewhere). " +
    "The working directory persists between calls: `cd` carries over to the next command (on success); it starts at the workspace root. " +
    "Do NOT use this for things a dedicated tool does better: reading files (read_file), editing (replace_in_file), " +
    "creating files (write_file), finding files (glob), or searching content (grep). " +
    "For anything that may run long — installs, builds, test suites, dev servers — set run_in_background=true; " +
    "it returns a job id immediately and you poll it with get_command_output instead of blocking. " +
    "Quote paths containing spaces. Output is truncated when very large.",
  risk: "execute",
  concurrencySafe: false,
  // 自管超时（HARNESS_COMMAND_TIMEOUT_MS，默认 10 分钟）：豁免执行器的全局工具超时，
  // 否则长命令会被执行器在全局上限处掐断。
  timeoutMs: 0,
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

    // 上一条命令留下的 cwd 仍存在则沿用，否则回退工作区根。
    const effectiveCwd = persistentCwd && existsSync(persistentCwd) ? persistentCwd : context.cwd;

    if (run_in_background) {
      const job = startBackgroundCommand(command, effectiveCwd);
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
    const wrapped = withCwdSentinel(command);
    return await new Promise<string>((resolve, reject) => {
      exec(
        wrapped.command,
        {
          cwd: effectiveCwd,
          signal: context.signal,
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          // 无论成败都先解析/剥离哨兵；命令失败时 && 短路、不会打印哨兵（即不更新 cwd）。
          const extracted = wrapped.hasSentinel ? extractCwd(stdout) : { output: stdout, cwd: null };
          if (extracted.cwd && existsSync(extracted.cwd)) persistentCwd = extracted.cwd;

          const output = [extracted.output, stderr].filter(Boolean).join("\n").trim();
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
