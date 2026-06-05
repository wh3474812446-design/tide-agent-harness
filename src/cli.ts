import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentLoop } from "./core/agent-loop.js";
import { EventBus } from "./events.js";
import { createTideRuntime, loadTideEnv } from "./app/runtime.js";

const cwd = process.cwd();
const loadedEnvCount = await loadTideEnv(cwd);
if (loadedEnvCount > 0) console.log(`[config] loaded ${loadedEnvCount} value(s) from .env`);

const prompt = process.argv.slice(2).join(" ").trim();
const terminal = createInterface({ input: stdin, output: stdout });
const events = new EventBus();
events.subscribe((event) => {
  if (event.type === "tool.started") console.log(`[tool] starting ${event.name}`);
  if (event.type === "tool.finished") console.log(`[tool] finished ${event.name}, error=${event.isError}`);
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
