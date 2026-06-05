import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ScriptedProvider } from "../src/model/scripted-provider.js";
import { RiskPolicy } from "../src/policy/policy.js";
import { SessionStore } from "../src/session/session-store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/tool.js";

test("agent loop sends tool results back to the model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-agent-"));
  try {
    const provider = new ScriptedProvider([
      {
        content: [{ type: "tool_call", id: "call-1", name: "echo", input: { text: "hello" } }],
      },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "Echo text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      risk: "read",
      concurrencySafe: true,
      async execute(input) {
        return (input as { text: string }).text;
      },
    });
    const executor = new ToolExecutor({ cwd: directory, registry, policy: new RiskPolicy() });
    const agent = new AgentLoop({
      provider,
      registry,
      executor,
      sessions: new SessionStore(path.join(directory, ".sessions")),
    });

    const result = await agent.run("start");
    assert.equal(result.finalText, "done");
    assert.equal(result.turns, 2);
    assert.equal(result.toolCalls, 1);

    const secondRequest = provider.requests[1];
    assert.ok(secondRequest);
    const toolResult = secondRequest.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    assert.deepEqual(toolResult, {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "echo",
      output: "hello",
      isError: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
