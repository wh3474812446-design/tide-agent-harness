import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager } from "../src/context/context-manager.js";
import type { Message } from "../src/types.js";

test("context compaction keeps tool calls paired with tool results", () => {
  const messages: Message[] = [
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
        {
          type: "tool_result",
          toolCallId: "paired",
          toolName: "read_file",
          output: "result ".repeat(80),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
  ];

  const result = new ContextManager(250).prepare(messages);
  assert.equal(result.compacted, true);
  const blocks = result.messages.flatMap((message) => message.content);
  const hasCall = blocks.some((block) => block.type === "tool_call" && block.id === "paired");
  const hasResult = blocks.some(
    (block) => block.type === "tool_result" && block.toolCallId === "paired",
  );
  assert.equal(hasCall, hasResult);
});

