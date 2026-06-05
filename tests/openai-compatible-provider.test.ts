import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OpenAICompatibleProvider } from "../src/model/openai-compatible-provider.js";

test("openai-compatible provider maps messages, tools, and tool calls", async () => {
  let requestBody: unknown;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "I will inspect that file.",
                tool_calls: [
                  {
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "README.md" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
    });
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "test-model",
  });

  try {
    const result = await provider.complete({
      systemPrompt: "system prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "start" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "call-1", name: "list_files", input: { path: "." } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              toolName: "list_files",
              output: "README.md",
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    });

    assert.deepEqual(result.content, [
      { type: "text", text: "I will inspect that file." },
      {
        type: "tool_call",
        id: "call-2",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
    assert.equal(result.stopReason, "tool_calls");
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });

    const body = requestBody as {
      model: string;
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    assert.equal(body.model, "test-model");
    assert.equal(body.messages[0]?.role, "system");
    assert.equal(body.messages[1]?.role, "user");
    assert.equal(body.messages[2]?.role, "assistant");
    assert.equal(body.messages[3]?.role, "tool");
    assert.equal(body.tools[0]?.type, "function");
  } finally {
    await close(server);
  }
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
