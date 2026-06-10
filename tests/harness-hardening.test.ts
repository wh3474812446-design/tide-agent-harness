import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ContextManager } from "../src/context/context-manager.js";
import { EventBus } from "../src/events.js";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible-provider.js";
import { ScriptedProvider } from "../src/model/scripted-provider.js";
import { RiskPolicy } from "../src/policy/policy.js";
import { SessionStore } from "../src/session/session-store.js";
import { resetCommandCwd, runCommandTool } from "../src/tools/builtins/run-command.js";
import { TodoStore, createTodoWriteTool } from "../src/tools/builtins/todo-write.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/tool.js";
import type { Tool } from "../src/tools/tool.js";
import type { Message, ModelResponse } from "../src/types.js";

// ---------- provider 重试 ----------

test("provider retries transient 429 and succeeds; message order keeps tool before user text", async () => {
  let hits = 0;
  let secondBody: any;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(429, { "retry-after": "0" });
        response.end("rate limited");
        return;
      }
      secondBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const provider = new OpenAICompatibleProvider({
    apiKey: "k",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "m",
  });

  const previousBase = process.env.HARNESS_API_RETRY_BASE_MS;
  process.env.HARNESS_API_RETRY_BASE_MS = "1";
  try {
    const result = await provider.complete({
      systemPrompt: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "echo", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "c1", toolName: "echo", output: "result" },
            { type: "text", text: "<system-reminder>提醒</system-reminder>" },
          ],
        },
      ],
      tools: [],
    });
    assert.equal(result.content[0]?.type, "text");
    assert.equal(hits, 2);
    // tool 消息必须紧跟 assistant；同条消息里的提醒文本要排在 tool 之后。
    const roles = secondBody.messages.map((m: { role: string }) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user"]);
  } finally {
    if (previousBase === undefined) delete process.env.HARNESS_API_RETRY_BASE_MS;
    else process.env.HARNESS_API_RETRY_BASE_MS = previousBase;
    await close(server);
  }
});

test("provider does not retry non-retryable 400", async () => {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("bad request");
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  const provider = new OpenAICompatibleProvider({
    apiKey: "k",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "m",
  });
  try {
    await assert.rejects(provider.complete({ systemPrompt: "s", messages: [], tools: [] }), /400/);
    assert.equal(hits, 1);
  } finally {
    await close(server);
  }
});

// ---------- 执行器超时覆盖 ----------

test("executor timeout: global default applies, tool-level 0 exempts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-timeout-"));
  const slow: Tool = {
    name: "slow",
    description: "",
    inputSchema: { type: "object", additionalProperties: true },
    risk: "read",
    concurrencySafe: false,
    execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 120)),
  };
  const exempt: Tool = { ...slow, name: "slow_exempt", timeoutMs: 0 };
  const registry = new ToolRegistry();
  registry.register(slow);
  registry.register(exempt);
  const executor = new ToolExecutor({ cwd: dir, registry, policy: new RiskPolicy(), timeoutMs: 40 });

  const timedOut = await executor.executeOne({ type: "tool_call", id: "1", name: "slow", input: {} });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.output, /timed out/);

  const finished = await executor.executeOne({ type: "tool_call", id: "2", name: "slow_exempt", input: {} });
  assert.equal(finished.isError, false);
  assert.equal(finished.output, "done");
});

// ---------- microcompact ----------

function bigToolHistory(extraOldText = ""): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "task" }] },
    ...(extraOldText
      ? [{ role: "assistant" as const, content: [{ type: "text" as const, text: extraOldText }] }]
      : []),
    { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "read_file", input: { path: "x" } }] },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "t1", toolName: "read_file", output: "z".repeat(3000) }],
    },
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
    { role: "assistant", content: [{ type: "text", text: "latest" }] },
  ];
}

test("microcompact clears old tool results without calling the summarizer", async () => {
  const manager = new ContextManager({ maxApproxTokens: 600, keepRecentTokens: 100 });
  let summarizerCalls = 0;
  const result = await manager.compact(bigToolHistory(), async () => {
    summarizerCalls += 1;
    return "<summary>unused</summary>";
  });

  assert.equal(result.compacted, true);
  assert.equal(result.mode, "micro");
  assert.equal(summarizerCalls, 0);
  const blocks = result.messages.flatMap((m) => m.content);
  const cleared = blocks.find((b) => b.type === "tool_result" && b.toolCallId === "t1");
  assert.ok(cleared && cleared.type === "tool_result");
  assert.match(cleared.output, /已清理/);
  assert.ok(result.afterTokens < result.beforeTokens);
});

test("microcompact falls through to summary when clearing is not enough", async () => {
  const manager = new ContextManager({ maxApproxTokens: 600, keepRecentTokens: 100 });
  const result = await manager.compact(bigToolHistory("old ".repeat(1500)), async () => "<summary>S</summary>");
  assert.equal(result.mode, "summary");
  const first = result.messages[0];
  assert.equal(first?.role, "user");
  // 压缩封装会剥掉 <summary> 标签，只保留摘要内文。
  assert.match((first?.content[0] as { text: string }).text, /Summary:\s*\nS\b/);
});

// ---------- run_command 持久 cwd ----------

test("run_command persists cwd across calls (cd carries over)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-cwd-"));
  try {
    resetCommandCwd();
    const context = { cwd: dir, signal: new AbortController().signal };
    await mkdir(path.join(dir, "sub"));
    await runCommandTool.execute({ command: "cd sub" }, context);
    const where = await runCommandTool.execute(
      { command: process.platform === "win32" ? "cd" : "pwd" },
      context,
    );
    assert.match(where, /sub/);
  } finally {
    resetCommandCwd();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- todo system-reminder 注入 ----------

test("agent loop injects a stale-todo reminder after many tool calls without todo_write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-reminder-"));
  const todoStore = new TodoStore();
  todoStore.set([{ content: "做完整个任务", status: "pending" }]);

  const responses: ModelResponse[] = [];
  for (let i = 0; i < 10; i += 1) {
    responses.push({ content: [{ type: "tool_call", id: `c${i}`, name: "noop", input: {} }] });
  }
  responses.push({ content: [{ type: "text", text: "done" }] });
  const provider = new ScriptedProvider(responses);

  const noop: Tool = {
    name: "noop",
    description: "",
    inputSchema: { type: "object", additionalProperties: true },
    risk: "read",
    concurrencySafe: true,
    execute: async () => "ok",
  };
  const registry = new ToolRegistry();
  registry.register(noop);
  registry.register(createTodoWriteTool({ store: todoStore }));
  const executor = new ToolExecutor({ cwd: dir, registry, policy: new RiskPolicy() });
  const agent = new AgentLoop({
    provider,
    registry,
    executor,
    sessions: new SessionStore(path.join(dir, ".sessions")),
    todoStore,
    maxTurns: 20,
  });

  const result = await agent.run("long job");
  assert.equal(result.finalText, "done");
  const reminderTexts = result.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .filter((t) => t.includes("system-reminder"));
  assert.ok(
    reminderTexts.some((t) => /任务清单已连续/.test(t)),
    "should inject a stale-todo system-reminder",
  );
});

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
