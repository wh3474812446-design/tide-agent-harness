import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ContextManager } from "../src/context/context-manager.js";
import { EventBus, type HarnessEvent } from "../src/events.js";
import { ScriptedProvider } from "../src/model/scripted-provider.js";
import { RiskPolicy } from "../src/policy/policy.js";
import { SessionStore } from "../src/session/session-store.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/tool.js";
import type { Message } from "../src/types.js";

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

test("agent loop auto-compacts oversized history before the model turn", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-compact-"));
  try {
    // 第 1 个响应是压缩摘要这一轮的输出；第 2 个是真正这一轮（无工具→收尾）。
    const provider = new ScriptedProvider([
      { content: [{ type: "text", text: "<summary>earlier work condensed</summary>" }] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const registry = new ToolRegistry();
    const executor = new ToolExecutor({ cwd: directory, registry, policy: new RiskPolicy() });
    const sessions = new SessionStore(path.join(directory, ".sessions"));

    // 预置一段超预算的历史。
    const session = sessions.create();
    const filler: Message[] = [];
    for (let i = 0; i < 8; i += 1) {
      filler.push({ role: "user", content: [{ type: "text", text: `older message ${i} ${"x".repeat(60)}` }] });
      filler.push({ role: "assistant", content: [{ type: "text", text: `older reply ${i} ${"y".repeat(60)}` }] });
    }
    session.messages.push(...filler);
    await sessions.save(session);

    const events = new EventBus();
    const seen: HarnessEvent[] = [];
    events.subscribe((event) => seen.push(event));

    const agent = new AgentLoop({
      provider,
      registry,
      executor,
      sessions,
      events,
      context: new ContextManager({ maxApproxTokens: 300, keepRecentTokens: 80 }),
    });

    const result = await agent.run("next step", { sessionId: session.id });
    assert.equal(result.finalText, "done");

    // 触发了压缩事件。
    assert.ok(seen.some((e) => e.type === "context.compacted"));

    // 摘要这一轮：不带工具、单条用户消息（转录）。
    const summaryReq = provider.requests[0];
    assert.ok(summaryReq);
    assert.equal(summaryReq.tools.length, 0);
    assert.equal(summaryReq.messages.length, 1);

    // 真正这一轮：历史已被压缩，开头是携带摘要的消息，且条数远少于原始 17 条。
    const realReq = provider.requests[1];
    assert.ok(realReq);
    const firstText = realReq.messages[0]?.content.find((b) => b.type === "text");
    assert.match((firstText as { text: string }).text, /earlier work condensed/);
    assert.ok(realReq.messages.length < filler.length + 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
