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
  const skillsDir = process.env.HARNESS_SKILLS_DIR
    ? path.resolve(process.env.HARNESS_SKILLS_DIR)
    : path.join(cwd, "skills");
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

// 实时显示工具调用与关键状态，做出 Claude Code 那样“边干边说”的观感。
events.subscribe((event) => {
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
  approval: async ({ tool, input }) => {
    console.log(ui.note(`需要授权：${tool.name}（${tool.risk}）`));
    console.log(ui.note(JSON.stringify(input)));
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
    const result = await agent.run(prompt);
    console.log(ui.assistant(result.finalText));
    console.log(ui.stats(result.turns, result.toolCalls, result.sessionId));
  } else {
    await runInteractiveChat(agent, terminal);
  }
} finally {
  terminal.close();
  await runtime.dispose();
}

async function runInteractiveChat(
  agent: AgentLoop,
  terminal: ReturnType<typeof createInterface>,
): Promise<void> {
  let sessionId: string | undefined;
  while (true) {
    const answer = await askQuestion(terminal, `\n${ui.promptLabel()}`);
    if (answer === undefined) break;
    const input = answer.trim();
    if (!input) continue;

    // 斜杠命令，模仿 Claude Code 的 /new、/exit。
    if (input === "/exit" || input === "/quit") break;
    if (input === "/new" || input === "/clear") {
      sessionId = undefined;
      console.log(ui.note("已开启新会话。"));
      continue;
    }

    try {
      const result = await agent.run(input, { sessionId });
      sessionId = result.sessionId;
      console.log(ui.assistant(result.finalText));
      console.log(ui.stats(result.turns, result.toolCalls, result.sessionId));
    } catch (error) {
      console.log(ui.errorLine(error instanceof Error ? error.message : String(error)));
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
