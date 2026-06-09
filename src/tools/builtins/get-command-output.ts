import type { Tool } from "../tool.js";
import { getJob } from "./command-jobs.js";

interface GetCommandOutputInput {
  id: string;
  onlyNew?: boolean;
}

export const getCommandOutputTool: Tool = {
  name: "get_command_output",
  description:
    "Fetch the accumulated output and status of a background command started by run_command (run_in_background=true). " +
    "By default returns only output produced since the last fetch.",
  risk: "read",
  concurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, description: "Job id returned by run_command." },
      onlyNew: { type: "boolean", description: "Return only output since last fetch (default true)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(input) {
    const { id, onlyNew = true } = input as GetCommandOutputInput;
    const job = getJob(id);
    if (!job) return `没有找到后台任务：${id}（可能已随 Tide 重启清空）。`;

    const status = job.exitCode === null ? "运行中" : `已结束（退出码 ${job.exitCode}）`;
    const chunk = onlyNew ? job.output.slice(job.readCursor) : job.output;
    job.readCursor = job.output.length;

    const header = `任务 ${id} · ${status}\n命令：${job.command}`;
    if (!chunk) {
      return `${header}\n（${onlyNew ? "暂无新输出" : "暂无输出"}）`;
    }
    return `${header}\n--- 输出 ---\n${chunk}`;
  },
};
