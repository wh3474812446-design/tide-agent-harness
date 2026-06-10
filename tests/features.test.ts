import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { estimateCost } from "../src/model/pricing.js";
import { formatReplaceDiff, formatWriteDiff } from "../src/tools/builtins/diff.js";
import { CheckpointStore } from "../src/checkpoint/checkpoint.js";
import { HookRunner } from "../src/hooks/hooks.js";
import { RiskPolicy } from "../src/policy/policy.js";
import { parseDuckDuckGo } from "../src/tools/builtins/web-search.js";
import { htmlToText } from "../src/tools/builtins/web-fetch.js";
import { createSpawnAgentTool } from "../src/tools/builtins/spawn-agent.js";
import { ScriptedProvider } from "../src/model/scripted-provider.js";
import { ToolRegistry } from "../src/tools/tool.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { SessionStore } from "../src/session/session-store.js";
import { EventBus } from "../src/events.js";
import { AgentLoop } from "../src/core/agent-loop.js";
import type { ModelProvider } from "../src/model/provider.js";
import type { Tool } from "../src/tools/tool.js";

test("estimateCost prices known models, undefined for unknown", () => {
  const cost = estimateCost("deepseek-chat", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(cost && cost > 0);
  assert.equal(estimateCost("totally-unknown-model", { inputTokens: 100, outputTokens: 100 }), undefined);
});

test("diff helpers mark added/removed lines", () => {
  const r = formatReplaceDiff("a.ts", "old line", "new line");
  assert.match(r, /- old line/);
  assert.match(r, /\+ new line/);
  const w = formatWriteDiff("b.ts", null, "hello\nworld");
  assert.match(w, /新建 b\.ts/);
});

test("RiskPolicy plan mode blocks non-read risks", async () => {
  const policy = new RiskPolicy({ allow: ["read", "write", "execute", "network"] });
  const writeTool = { name: "w", description: "", inputSchema: {}, risk: "write" as const, concurrencySafe: false, execute: async () => "" };
  assert.equal((await policy.decide(writeTool, {})).allowed, true);
  policy.setPlanMode(true);
  assert.equal((await policy.decide(writeTool, {})).allowed, false);
  const readTool = { ...writeTool, risk: "read" as const };
  assert.equal((await policy.decide(readTool, {})).allowed, true);
});

test("CheckpointStore restores modified file and deletes newly created file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-cp-"));
  const existing = path.join(dir, "keep.txt");
  await writeFile(existing, "original", "utf8");
  const created = path.join(dir, "new.txt");

  const store = new CheckpointStore();
  store.begin("test edit");
  await store.backup(existing);
  await store.backup(created); // 不存在
  await writeFile(existing, "changed", "utf8");
  await writeFile(created, "brand new", "utf8");

  const result = await store.rewindLast();
  assert.ok(result);
  assert.equal(await readFile(existing, "utf8"), "original");
  await assert.rejects(access(created)); // 新建的被删
});

test("HookRunner PreToolUse blocks on non-zero exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-hook-"));
  const runner = new HookRunner({ PreToolUse: [{ matcher: "run_command", command: "exit 1" }] }, dir);
  const blocked = await runner.runPreToolUse("run_command", {});
  assert.equal(blocked.block, true);
  const allowed = await runner.runPreToolUse("read_file", {});
  assert.equal(allowed.block, false); // 不匹配的工具不受影响
});

test("parseDuckDuckGo extracts results; htmlToText strips tags", () => {
  const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example Title</a>
    <a class="result__snippet">A snippet here</a>`;
  const results = parseDuckDuckGo(html);
  assert.equal(results[0]?.url, "https://example.com");
  assert.match(results[0]?.title ?? "", /Example Title/);
  assert.equal(htmlToText("<p>Hello <b>world</b></p><script>bad()</script>"), "Hello world");
});

test("AgentLoop hits maxTurns gracefully (returns note, does not throw)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-turns-"));
  // 永远只要工具、从不收尾的 provider，必然撞上限。
  const loopingProvider: ModelProvider = {
    model: "deepseek-chat",
    async complete() {
      return {
        content: [{ type: "tool_call", id: `c${Math.random()}`, name: "noop", input: {} }],
        stopReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
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
  const policy = new RiskPolicy({ allow: ["read"] });
  const events = new EventBus();
  const executor = new ToolExecutor({ cwd: dir, registry, policy, events });
  const agent = new AgentLoop({
    provider: loopingProvider,
    registry,
    executor,
    sessions: new SessionStore(path.join(dir, ".sessions")),
    events,
    maxTurns: 2,
  });
  const result = await agent.run("loop forever");
  assert.equal(result.turns, 2);
  assert.match(result.finalText, /最大对话轮数/);
});

test("spawn_agent runs a child agent and returns its result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-spawn-"));
  const fakeProvider: ModelProvider = {
    model: "deepseek-chat",
    async complete() {
      return { content: [{ type: "text", text: "子任务完成了" }], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const registry = new ToolRegistry();
  const policy = new RiskPolicy({ allow: ["read"] });
  const events = new EventBus();
  const executor = new ToolExecutor({ cwd: dir, registry, policy, events });
  const sessions = new SessionStore(path.join(dir, ".sessions"));
  const tool = createSpawnAgentTool({
    provider: fakeProvider,
    sessions,
    events,
    systemPrompt: "test",
    general: { registry, executor },
    explore: { registry, executor },
  });

  const out = await tool.execute({ prompt: "做个子任务", description: "测试" }, { cwd: dir, signal: new AbortController().signal });
  assert.match(out, /子任务完成了/);
  assert.match(out, /测试/);
});

test("spawn_agent explore type uses the read-only registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-spawn-explore-"));
  const scripted = new ScriptedProvider([
    { content: [{ type: "text", text: "调研结论" }], stopReason: "stop" },
  ]);
  const events = new EventBus();
  const policy = new RiskPolicy({ allow: ["read", "write"] });
  const sessions = new SessionStore(path.join(dir, ".sessions"));

  const writeTool: Tool = {
    name: "fake_write",
    description: "",
    inputSchema: { type: "object", additionalProperties: true },
    risk: "write",
    concurrencySafe: false,
    execute: async () => "wrote",
  };
  const readTool: Tool = { ...writeTool, name: "fake_read", risk: "read" };
  const generalRegistry = new ToolRegistry();
  generalRegistry.register(writeTool);
  generalRegistry.register(readTool);
  const exploreRegistry = new ToolRegistry();
  exploreRegistry.register(readTool);

  const tool = createSpawnAgentTool({
    provider: scripted,
    sessions,
    events,
    systemPrompt: "test",
    general: { registry: generalRegistry, executor: new ToolExecutor({ cwd: dir, registry: generalRegistry, policy, events }) },
    explore: { registry: exploreRegistry, executor: new ToolExecutor({ cwd: dir, registry: exploreRegistry, policy, events }) },
  });

  const out = await tool.execute(
    { prompt: "去调研", agent_type: "explore" },
    { cwd: dir, signal: new AbortController().signal },
  );
  assert.match(out, /调研结论/);
  assert.match(out, /explore/);
  // 子代理看到的工具集只有只读工具。
  const childRequest = scripted.requests[0];
  assert.ok(childRequest);
  const toolNames = childRequest.tools.map((t) => t.name);
  assert.ok(toolNames.includes("fake_read"));
  assert.ok(!toolNames.includes("fake_write"));
});
