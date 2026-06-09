import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentLoop } from "./core/agent-loop.js";
import { EventBus } from "./events.js";
import { createTideRuntime, loadTideEnv } from "./app/runtime.js";
import { installSkill } from "./skills/index.js";

const cwd = process.cwd();
const loadedEnvCount = await loadTideEnv(cwd);
if (loadedEnvCount > 0) console.log(`[config] loaded ${loadedEnvCount} value(s) from .env`);

const argv = process.argv.slice(2);

// 子命令：tide --install-skill <本地目录或 git URL> [--overwrite]
const installFlagIndex = argv.indexOf("--install-skill");
if (installFlagIndex !== -1) {
  const source = argv[installFlagIndex + 1];
  if (!source) {
    console.error("Usage: --install-skill <local-dir-or-git-url> [--overwrite]");
    process.exit(1);
  }
  const skillsDir = process.env.HARNESS_SKILLS_DIR
    ? path.resolve(process.env.HARNESS_SKILLS_DIR)
    : path.join(cwd, "skills");
  try {
    const result = await installSkill(source, skillsDir, { overwrite: argv.includes("--overwrite") });
    console.log(
      `[skill] installed "${result.name}" -> ${result.dir}${result.overwritten ? " (overwritten)" : ""}`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`[skill] install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const prompt = argv.join(" ").trim();
const terminal = createInterface({ input: stdin, output: stdout });
const events = new EventBus();
events.subscribe((event) => {
  if (event.type === "tool.started") console.log(`[tool] starting ${event.name}`);
  if (event.type === "tool.finished") console.log(`[tool] finished ${event.name}, error=${event.isError}`);
  if (event.type === "mcp.connected") console.log(`[mcp] ${event.server}: ${event.tools} tool(s)`);
  if (event.type === "mcp.failed") console.log(`[mcp] ${event.server} failed: ${event.error}`);
});

const runtime = await createTideRuntime({
  cwd,
  events,
  approval: async ({ tool, input }) => {
    console.log(`\nApproval required for ${tool.name} (${tool.risk}):`);
    console.log(JSON.stringify(input, null, 2));
    const answer = await terminal.question("Allow? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  },
});
if (runtime.loadedApiTools > 0) console.log(`[tools] loaded ${runtime.loadedApiTools} API tool(s)`);
if (runtime.loadedMcpTools > 0) {
  console.log(`[mcp] ${runtime.loadedMcpTools} tool(s) from ${runtime.mcpServers.filter((s) => s.ok).length} server(s)`);
}
if (runtime.skills.length > 0) console.log(`[skills] ${runtime.skills.length} skill(s) available`);
const agent = runtime.agent;

try {
  if (prompt) {
    const result = await agent.run(prompt);
    console.log(`\n${result.finalText}\n\nSession: ${result.sessionId}`);
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
  console.log("Tide is running. Type a message to chat, or press Enter on an empty line to exit.");
  while (true) {
    const answer = await askQuestion(terminal, "\nYou> ");
    if (answer === undefined) break;
    const input = answer.trim();
    if (!input) break;
    const result = await agent.run(input, { sessionId });
    sessionId = result.sessionId;
    console.log(`\nTide> ${result.finalText}`);
    console.log(`Session: ${result.sessionId}, turns: ${result.turns}, tool calls: ${result.toolCalls}`);
  }
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
