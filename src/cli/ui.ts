import { stdout } from "node:process";
import { formatCost } from "../model/pricing.js";

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code: string): (s: string) => string {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const color = {
  dim: wrap("2"),
  bold: wrap("1"),
  cyan: wrap("36"),
  green: wrap("32"),
  red: wrap("31"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  gray: wrap("90"),
};

/** Tide 启动横幅，风格对照 Claude Code 的欢迎框。 */
export function banner(info: {
  model: string;
  workspace: string;
  risks: string;
  tools: number;
  mcp: number;
  skills: number;
  projectContext: boolean;
}): string {
  const { dim, bold, cyan, green } = color;
  const line = dim("─".repeat(58));
  const rows = [
    "",
    `  ${cyan("≈≈≈")}  ${bold("Tide")} ${dim("· 本地智能体终端")}`,
    `  ${line}`,
    `  ${dim("模型")}    ${green(info.model)}`,
    `  ${dim("工作区")}  ${info.workspace}`,
    `  ${dim("权限")}    ${info.risks}`,
    `  ${dim("工具")}    ${info.tools} 个内置/扩展` +
      (info.mcp ? dim(` · MCP ${info.mcp}`) : "") +
      (info.skills ? dim(` · 技能 ${info.skills}`) : "") +
      (info.projectContext ? green(" · 已载项目记忆") : ""),
    `  ${line}`,
    `  ${dim("命令：")} ${cyan("/new")} ${dim("新会话")}  ${cyan("/plan")} ${dim("计划模式")}  ${cyan("/rewind")} ${dim("回滚")}  ${cyan("/exit")} ${dim("退出")}`,
    "",
  ];
  return rows.join("\n");
}

/** 用户输入提示符。 */
export function promptLabel(): string {
  return color.cyan("› ");
}

/** 助手回复表头（流式时单独打印）。 */
export function assistantHeader(): string {
  return color.bold(color.cyan("≈ Tide"));
}

/** 助手回复块（非流式时一次性打印）。 */
export function assistant(text: string): string {
  return `\n${assistantHeader()}\n${text}\n`;
}

/** 工具调用：开始。 */
export function toolStart(name: string): string {
  return color.dim(`  ⏺ ${name} …`);
}

/** 工具调用：结束。 */
export function toolDone(name: string, isError: boolean): string {
  return isError
    ? color.red(`  ✗ ${name} 失败`)
    : color.gray(`  ⎿ ${name} 完成`);
}

/** 一行系统/状态提示。 */
export function note(text: string): string {
  return color.dim(`  ${text}`);
}

export function errorLine(text: string): string {
  return color.red(`  ✗ ${text}`);
}

/** 渲染编辑预览：+ 行绿、- 行红，其余暗色，整体缩进。 */
export function diff(preview: string): string {
  return preview
    .split("\n")
    .map((line) => {
      if (line.startsWith("+ ")) return color.green(`  ${line}`);
      if (line.startsWith("- ")) return color.red(`  ${line}`);
      return color.dim(`  ${line}`);
    })
    .join("\n");
}

/** 会话结束的统计行。 */
export function stats(opts: {
  turns: number;
  toolCalls: number;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}): string {
  const tokens = `${opts.inputTokens}↑/${opts.outputTokens}↓ tok`;
  const cost = opts.costUsd !== undefined ? ` · ~${formatCost(opts.costUsd)}` : "";
  return color.gray(
    `  ${opts.turns} 轮 · ${opts.toolCalls} 次工具 · ${tokens}${cost} · 会话 ${opts.sessionId.slice(0, 8)}`,
  );
}
