import path from "node:path";
import { AgentLoop } from "./core/agent-loop.js";
import { EventBus } from "./events.js";
import { ScriptedProvider } from "./model/scripted-provider.js";
import { RiskPolicy } from "./policy/policy.js";
import { SessionStore } from "./session/session-store.js";
import { createDefaultToolRegistry } from "./tools/builtins/index.js";
import { ToolExecutor } from "./tools/executor.js";

const cwd = process.cwd();
const events = new EventBus();
events.subscribe((event) => console.log(`[event] ${event.type}`, event));

const provider = new ScriptedProvider([
  {
    content: [
      { type: "text", text: "我先检查一下工作区。" },
      { type: "tool_call", id: "demo-list-1", name: "list_files", input: { path: "." } },
    ],
    stopReason: "tool_use",
  },
  {
    content: [
      {
        type: "text",
        text: "Tide completed a full model -> tool -> model loop. Check the event log above.",
      },
    ],
    stopReason: "end_turn",
  },
]);

const registry = createDefaultToolRegistry();
const executor = new ToolExecutor({
  cwd,
  registry,
  policy: new RiskPolicy(),
  events,
});
const agent = new AgentLoop({
  provider,
  registry,
  executor,
  sessions: new SessionStore(path.join(cwd, ".sessions")),
  events,
});

const result = await agent.run("Inspect this workspace and tell me what Tide just did.");
console.log(`\nTide response:\n${result.finalText}`);
console.log(`\nSession: ${result.sessionId}, turns: ${result.turns}, tool calls: ${result.toolCalls}`);
