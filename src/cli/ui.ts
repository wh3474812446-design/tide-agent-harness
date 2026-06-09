import { stdout } from "node:process";

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
    `  ${dim("输入消息开始对话。命令：")} ${cyan("/new")} ${dim("新会话")}  ${cyan("/exit")} ${dim("退出")}`,
    "",
  ];
  return rows.join("\n");
}

/** 用户输入提示符。 */
export function promptLabel(): string {
  return color.cyan("› ");
}

/** 助手回复块。 */
export function assistant(text: string): string {
  const head = color.bold(color.cyan("≈ Tide"));
  return `\n${head}\n${text}\n`;
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

/** 会话结束的统计行。 */
export function stats(turns: number, toolCalls: number, sessionId: string): string {
  return color.gray(`  ${turns} 轮 · ${toolCalls} 次工具调用 · 会话 ${sessionId.slice(0, 8)}`);
}
