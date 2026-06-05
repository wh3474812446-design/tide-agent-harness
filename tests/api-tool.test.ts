import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { RiskPolicy } from "../src/policy/policy.js";
import { createApiTool, registerApiToolsFromFile } from "../src/tools/api/api-tool.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/tool.js";

test("api tool renders input and env templates into an HTTP request", async () => {
  const seen: {
    method?: string;
    url?: string;
    authorization?: string;
    body?: unknown;
  } = {};

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen.method = request.method;
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ received: true, body: seen.body }));
    });
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  const registry = new ToolRegistry();
  registry.register(
    createApiTool(
      {
        name: "lookup_user",
        description: "Look up a user through a test API.",
        method: "POST",
        url: `http://127.0.0.1:${address.port}/users/{{input.userId}}`,
        headers: {
          authorization: "Bearer {{env.TEST_TOKEN}}",
        },
        query: {
          limit: "{{input.limit}}",
        },
        body: {
          tag: "{{input.tag}}",
          payload: "{{input.payload}}",
        },
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            limit: { type: "integer" },
            tag: { type: "string" },
            payload: { type: "object" },
          },
          required: ["userId", "limit", "tag", "payload"],
          additionalProperties: false,
        },
      },
      { env: { TEST_TOKEN: "secret-token" } },
    ),
  );
  const executor = new ToolExecutor({
    cwd: os.tmpdir(),
    registry,
    policy: new RiskPolicy({ allow: ["read", "network"] }),
  });

  try {
    const result = await executor.executeOne({
      type: "tool_call",
      id: "call-1",
      name: "lookup_user",
      input: {
        userId: "u-123",
        limit: 3,
        tag: "active",
        payload: { score: 42 },
      },
    });

    assert.equal(result.isError, false);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/users/u-123?limit=3");
    assert.equal(seen.authorization, "Bearer secret-token");
    assert.deepEqual(seen.body, { tag: "active", payload: { score: 42 } });

    const output = JSON.parse(result.output) as {
      status: number;
      body: { received: boolean; body: unknown };
    };
    assert.equal(output.status, 200);
    assert.deepEqual(output.body, {
      received: true,
      body: { tag: "active", payload: { score: 42 } },
    });
  } finally {
    await close(server);
  }
});

test("api tool registration loads tools from a json file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-api-tools-"));
  try {
    const configPath = path.join(directory, "api-tools.json");
    await writeFile(
      configPath,
      JSON.stringify({
        tools: [
          {
            name: "ping_api",
            description: "Ping a test API.",
            url: "http://127.0.0.1/ping",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      }),
      "utf8",
    );

    const registry = new ToolRegistry();
    const count = await registerApiToolsFromFile(registry, configPath);
    assert.equal(count, 1);
    assert.ok(registry.get("ping_api"));
  } finally {
    await rm(directory, { recursive: true, force: true });
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
