import { spawn, type ChildProcess } from "node:child_process";

/**
 * 后台命令任务表（对照 Claude Code 的后台 Bash：长任务不阻塞对话，
 * 之后用 get_command_output 按 id 取累计输出）。进程内存储，随 Tide 退出而清空。
 */
export interface CommandJob {
  id: string;
  command: string;
  child: ChildProcess;
  output: string; // stdout + stderr 合并，按时间累计
  exitCode: number | null; // null 表示仍在运行
  startedAt: number;
  /** 自上次 get_command_output 以来未读取的输出起始位置。 */
  readCursor: number;
}

const jobs = new Map<string, CommandJob>();
let counter = 0;

const MAX_OUTPUT_CHARS = 200000; // 单任务输出上限，超出丢弃最旧部分

export function startBackgroundCommand(command: string, cwd: string): CommandJob {
  counter += 1;
  const id = `bg-${counter}-${Date.now().toString(36)}`;
  const child = spawn(command, { cwd, shell: true, windowsHide: true });

  const job: CommandJob = {
    id,
    command,
    child,
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    readCursor: 0,
  };

  const append = (chunk: Buffer | string): void => {
    job.output += chunk.toString();
    if (job.output.length > MAX_OUTPUT_CHARS) {
      const drop = job.output.length - MAX_OUTPUT_CHARS;
      job.output = job.output.slice(drop);
      job.readCursor = Math.max(0, job.readCursor - drop);
    }
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => {
    append(`\n[spawn error] ${err.message}`);
    job.exitCode = job.exitCode ?? -1;
  });
  child.on("close", (code) => {
    job.exitCode = code ?? 0;
  });

  jobs.set(id, job);
  return job;
}

export function getJob(id: string): CommandJob | undefined {
  return jobs.get(id);
}

export function listJobs(): CommandJob[] {
  return [...jobs.values()];
}
