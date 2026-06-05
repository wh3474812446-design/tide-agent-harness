import assert from "node:assert/strict";
import test from "node:test";
import { RiskPolicy } from "../src/policy/policy.js";
import type { Tool } from "../src/tools/tool.js";
import { resolveInsideWorkspace } from "../src/tools/builtins/path-utils.js";

const makeTool = (risk: Tool["risk"]): Tool => ({
  name: `${risk}_tool`,
  description: "test",
  inputSchema: { type: "object" },
  risk,
  concurrencySafe: risk === "read",
  async execute() {
    return "ok";
  },
});

test("default policy allows reads and fails closed for writes", async () => {
  const policy = new RiskPolicy();
  assert.equal((await policy.decide(makeTool("read"), {})).allowed, true);
  assert.equal((await policy.decide(makeTool("write"), {})).allowed, false);
});

test("approval handler can allow a write", async () => {
  const policy = new RiskPolicy({ approval: async () => true });
  assert.equal((await policy.decide(makeTool("write"), {})).allowed, true);
});

test("workspace path guard rejects parent traversal", () => {
  assert.throws(() => resolveInsideWorkspace("C:\\workspace", "..\\secret.txt"), /escapes/);
});

