import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager } from "../src/context/context-manager.js";
import type { Message } from "../src/types.js";

function bigConversation(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "initial task" }] },
    { role: "assistant", content: [{ type: "text", text: "old ".repeat(400) }] },
    { role: "user", content: [{ type: "text", text: "continue ".repeat(400) }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "paired", name: "read_file", input: { path: "a.txt" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolCallId: "paired", toolName: "read_file", output: "result ".repeat(80) },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
  ];
}

test("shouldCompact only fires past the token budget", () => {
  const small: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  assert.equal(new ContextManager({ maxApproxTokens: 250 }).shouldCompact(small), false);
  assert.equal(new ContextManager({ maxApproxTokens: 250 }).shouldCompact(bigConversation()), true);
});

test("compact summarizes the older portion and keeps recent tool pairs intact", async () => {
  const manager = new ContextManager({ maxApproxTokens: 250, keepRecentTokens: 400 });
  const summarize = async () => "<summary>condensed earlier work</summary>";
  const result = await manager.compact(bigConversation(), summarize);

  assert.equal(result.compacted, true);
  // 开头是一条携带摘要的用户消息。
  const first = result.messages[0];
  assert.equal(first?.role, "user");
  assert.match((first?.content[0] as { text: string }).text, /condensed earlier work/);
  // 最近段里的 tool_call / tool_result 配对要么都在、要么都不在（不被拆散）。
  const blocks = result.messages.flatMap((message) => message.content);
  const hasCall = blocks.some((block) => block.type === "tool_call" && block.id === "paired");
  const hasResult = blocks.some((block) => block.type === "tool_result" && block.toolCallId === "paired");
  assert.equal(hasCall, hasResult);
});

test("compact falls back to truncation when the summarizer fails", async () => {
  const manager = new ContextManager({ maxApproxTokens: 250, keepRecentTokens: 400 });
  const summarize = async () => {
    throw new Error("model unavailable");
  };
  const result = await manager.compact(bigConversation(), summarize);
  assert.equal(result.compacted, true);
  // 回退后仍保留最近答案，且不抛错。
  const text = result.messages.flatMap((m) => m.content).map((b) => (b.type === "text" ? b.text : "")).join(" ");
  assert.match(text, /latest answer/);
});
