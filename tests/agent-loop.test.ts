import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ContextManager } from "../src/context/context-manager.js";
import { EventBus, type HarnessEvent } from "../src/events.js";
import { ScriptedProvider } from "../src/model/scripted-provider.js";
import type { ModelProvider } from "../src/model/provider.js";
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

test("用户中断：模型思考期间 abort → 优雅返回 aborted，会话以收尾消息结束", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-abort-model-"));
  try {
    const controller = new AbortController();
    // 模拟「思考期间」：complete 一直挂着，直到 signal 被中止才 reject。
    const provider: ModelProvider = {
      model: "test-model",
      async complete(request) {
        return await new Promise((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const registry = new ToolRegistry();
    const executor = new ToolExecutor({ cwd: directory, registry, policy: new RiskPolicy() });
    const agent = new AgentLoop({
      provider,
      registry,
      executor,
      sessions: new SessionStore(path.join(directory, ".sessions")),
    });

    const runPromise = agent.run("帮我好好想想", { signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve)); // 让 run 进入 complete 并挂上中止监听
    controller.abort();
    const result = await runPromise;

    assert.equal(result.aborted, true);
    assert.ok(result.sessionId);
    const last = result.messages.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal(last?.content[0]?.type, "text");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("用户中断：工具执行期间 abort → 返回 aborted，且历史含 tool_result、以收尾消息结束", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-abort-tool-"));
  try {
    const controller = new AbortController();
    // 模型先要求调一个工具；该工具开跑后立刻模拟用户按下 ESC，然后挂起（由执行器的中止竞速收尾）。
    const provider = new ScriptedProvider([
      { content: [{ type: "tool_call", id: "call-1", name: "slow", input: {} }] },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: "slow",
      description: "A tool that hangs until aborted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      concurrencySafe: false,
      async execute(_input) {
        controller.abort();
        return await new Promise<string>(() => {});
      },
    });
    const executor = new ToolExecutor({ cwd: directory, registry, policy: new RiskPolicy() });
    const agent = new AgentLoop({
      provider,
      registry,
      executor,
      sessions: new SessionStore(path.join(directory, ".sessions")),
    });

    const result = await agent.run("跑个慢工具", { signal: controller.signal });

    assert.equal(result.aborted, true);
    const hasToolResult = result.messages
      .flatMap((message) => message.content)
      .some((block) => block.type === "tool_result");
    assert.ok(hasToolResult, "中止时应已写入工具结果，保持 tool_call/tool_result 配对合法");
    const last = result.messages.at(-1);
    assert.equal(last?.role, "assistant");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
