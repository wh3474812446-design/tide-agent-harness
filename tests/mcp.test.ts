import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMcpConfig, isStdioServer } from "../src/mcp/mcp-config.js";
import { mcpToolName } from "../src/mcp/mcp-manager.js";

async function writeConfig(content: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-mcp-"));
  const file = path.join(dir, "mcp.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

test("mcpToolName namespaces tools per server", () => {
  assert.equal(mcpToolName("filesystem", "read_file"), "mcp__filesystem__read_file");
});

test("loadMcpConfig accepts a valid stdio server", async () => {
  const file = await writeConfig({
    mcpServers: { fs: { command: "npx", args: ["-y", "server"] } },
  });
  const config = await loadMcpConfig(file);
  const server = config.mcpServers.fs;
  assert.ok(server);
  assert.equal(isStdioServer(server!), true);
});

test("loadMcpConfig accepts an http server", async () => {
  const file = await writeConfig({
    mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } },
  });
  const config = await loadMcpConfig(file);
  assert.equal(isStdioServer(config.mcpServers.remote!), false);
});

test("loadMcpConfig rejects a stdio server without a command", async () => {
  const file = await writeConfig({ mcpServers: { broken: { type: "stdio" } } });
  await assert.rejects(() => loadMcpConfig(file), /requires a string command/);
});

test("loadMcpConfig rejects an invalid server name", async () => {
  const file = await writeConfig({ mcpServers: { "bad name": { command: "x" } } });
  await assert.rejects(() => loadMcpConfig(file), /Invalid MCP server name/);
});

test("loadMcpConfig rejects a non-object root", async () => {
  const file = await writeConfig({ servers: [] });
  await assert.rejects(() => loadMcpConfig(file), /mcpServers map/);
});
