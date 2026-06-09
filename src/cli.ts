import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentLoop } from "./core/agent-loop.js";
import { EventBus } from "./events.js";
import { createTideRuntime, loadTideEnv } from "./app/runtime.js";
import { installSkill } from "./skills/index.js";
import * as ui from "./cli/ui.js";

const cwd = process.cwd();
// 先加载当前目录 .env（项目优先），再加载 Tide 安装目录 .env 补缺（如 API Key）——
// 这样从任意目录用 `tide` 启动都能拿到已配好的模型凭据。loadEnvFile 先到先得，不覆盖。
let loadedEnvCount = await loadTideEnv(cwd);
const tideRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (path.resolve(tideRoot) !== path.resolve(cwd)) {
  loadedEnvCount += await loadTideEnv(tideRoot);
}
if (loadedEnvCount > 0) console.log(ui.note(`已载入 ${loadedEnvCount} 项配置`));

const argv = process.argv.slice(2);

// 子命令：tide --install-skill <本地目录或 git URL> [--overwrite]
const installFlagIndex = argv.indexOf("--install-skill");
if (installFlagIndex !== -1) {
  const source = argv[installFlagIndex + 1];
  if (!source) {
    console.error("Usage: tide --install-skill <local-dir-or-git-url> [--overwrite]");
    process.exit(1);
  }
  // 与 runtime 一致：默认装到安装目录的 skills/，CLI 安装的技能网页端也能立即看到。
  const skillsDir = process.env.HARNESS_SKILLS_DIR
    ? path.resolve(process.env.HARNESS_SKILLS_DIR)
    : path.join(tideRoot, "skills");
  try {
    const result = await installSkill(source, skillsDir, { overwrite: argv.includes("--overwrite") });
    console.log(
      ui.note(`已安装技能 "${result.name}" -> ${result.dir}${result.overwritten ? "（覆盖）" : ""}`),
    );
    process.exit(0);
  } catch (error) {
    console.error(ui.errorLine(`技能安装失败：${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

const prompt = argv.join(" ").trim();
const terminal = createInterface({ input: stdin, output: stdout });
const events = new EventBus();

// 流式显示状态：是否在当前轮已打过“≈ Tide”表头、本次 run 是否流式过。
const stream = { headerThisTurn: false, didStream: false };

// 实时显示工具调用与关键状态，做出 Claude Code 那样“边干边说”的观感。
events.subscribe((event) => {
  if (event.type === "model.delta") {
    if (!stream.headerThisTurn) {
      stdout.write(`\n${ui.assistantHeader()}\n`);
      stream.headerThisTurn = true;
      stream.didStream = true;
    }
    stdout.write(event.text);
  }
  if (event.type === "model.responded") {
    if (stream.headerThisTurn) stdout.write("\n");
    stream.headerThisTurn = false;
  }
  if (event.type === "tool.started") console.log(ui.toolStart(event.name));
  if (event.type === "tool.finished") console.log(ui.toolDone(event.name, event.isError));
  if (event.type === "context.compacted") {
    console.log(ui.note(`上下文已压缩：${event.before} → ${event.after}`));
  }
  if (event.type === "mcp.connected") console.log(ui.note(`MCP ${event.server}：${event.tools} 个工具`));
  if (event.type === "mcp.failed") console.log(ui.errorLine(`MCP ${event.server} 失败：${event.error}`));
});

const runtime = await createTideRuntime({
  cwd,
  configRoot: tideRoot,
  events,
  approval: async ({ tool, input, preview }) => {
    console.log(ui.note(`需要授权：${tool.name}（${tool.risk}）`));
    if (preview) console.log(ui.diff(preview));
    else console.log(ui.note(JSON.stringify(input)));
    const answer = await terminal.question(ui.color.yellow("  允许执行？[y/N] "));
    return answer.trim().toLowerCase() === "y";
  },
});

console.log(
  ui.banner({
    model: runtime.providerName,
    workspace: runtime.workspaceRoot,
    risks: runtime.allowedRisks.join("、"),
    tools: runtime.tools.length,
    mcp: runtime.loadedMcpTools,
    skills: runtime.skills.length,
    projectContext: runtime.hasProjectContext,
  }),
);

const agent = runtime.agent;

try {
  if (prompt) {
    stream.headerThisTurn = false;
    stream.didStream = false;
    runtime.checkpoints.begin(prompt);
    const result = await agent.run(prompt);
    if (!stream.didStream) console.log(ui.assistant(result.finalText));
    console.log(printStats(result));
  } else {
    await runInteractiveChat(agent, terminal);
  }
} catch (error) {
  // 一次性模式下模型/网络报错时优雅提示，而不是抛出整页堆栈。
  console.log(ui.errorLine(describeError(error)));
  process.exitCode = 1;
} finally {
  terminal.close();
  await runtime.dispose();
}

/** 把错误（含 fetch 的 cause）格式化成一行可读信息。 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const causeMsg = cause instanceof Error ? `（${cause.message}）` : "";
  return `${error.message}${causeMsg}`;
}

function printStats(result: {
  turns: number;
  toolCalls: number;
  sessionId: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}): string {
  return ui.stats({
    turns: result.turns,
    toolCalls: result.toolCalls,
    sessionId: result.sessionId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.costUsd,
  });
}

async function runInteractiveChat(
  agent: AgentLoop,
  terminal: ReturnType<typeof createInterface>,
): Promise<void> {
  let sessionId: string | undefined;
  let planMode = false;
  while (true) {
    const answer = await askQuestion(terminal, `\n${planMode ? ui.color.yellow("[plan] ") : ""}${ui.promptLabel()}`);
    if (answer === undefined) break;
    const input = answer.trim();
    if (!input) continue;

    // 斜杠命令，模仿 Claude Code 的 /new、/exit、/plan。
    if (input === "/exit" || input === "/quit") break;
    if (input === "/new" || input === "/clear") {
      sessionId = undefined;
      console.log(ui.note("已开启新会话。"));
      continue;
    }
    if (input === "/plan") {
      planMode = !planMode;
      runtime.policy.setPlanMode(planMode);
      console.log(
        ui.note(
          planMode
            ? "已进入计划模式：只做调研/读取/搜索，写、执行、联网会被拦截。再输入 /plan 退出。"
            : "已退出计划模式，恢复正常权限。",
        ),
      );
      continue;
    }
    if (input === "/rewind") {
      const r = await runtime.checkpoints.rewindLast();
      console.log(
        ui.note(
          r
            ? `已回滚上一步改动（"${r.label}"），恢复 ${r.restored} 个文件。`
            : "没有可回滚的文件改动。",
        ),
      );
      continue;
    }

    // 计划模式下给模型加一句指令，让它先出计划而不是动手。
    const effectiveInput = planMode
      ? `（计划模式：只调研、读取、搜索，不要修改文件或执行命令；最后用分步清单给出你的计划，等我确认。）\n\n${input}`
      : input;

    try {
      stream.headerThisTurn = false;
      stream.didStream = false;
      runtime.checkpoints.begin(input);
      const result = await agent.run(effectiveInput, { sessionId });
      sessionId = result.sessionId;
      if (!stream.didStream) console.log(ui.assistant(result.finalText));
      console.log(printStats(result));
    } catch (error) {
      console.log(ui.errorLine(describeError(error)));
    }
  }
  console.log(ui.note("再见 👋"));
}

async function askQuestion(
  terminal: ReturnType<typeof createInterface>,
  query: string,
): Promise<string | undefined> {
  try {
    return await terminal.question(query);
  } catch (error) {
    if (isNodeError(error) && error.code === "ERR_USE_AFTER_CLOSE") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
