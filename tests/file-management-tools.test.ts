import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RiskPolicy } from "../src/policy/policy.js";
import { createDefaultToolRegistry } from "../src/tools/builtins/index.js";
import { ToolExecutor } from "../src/tools/executor.js";

test("file management tools can create, copy, move, and delete workspace paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tide-files-"));
  try {
    const executor = new ToolExecutor({
      cwd: directory,
      registry: createDefaultToolRegistry(),
      policy: new RiskPolicy({ allow: ["read", "write"] }),
    });
    let callCount = 0;
    const execute = async (name: string, input: unknown) => {
      const result = await executor.executeOne({
        type: "tool_call",
        id: `call-${++callCount}`,
        name,
        input,
      });
      assert.equal(result.isError, false, result.output);
      return result;
    };

    await execute("create_directory", { path: "notes/raw" });
    await execute("write_file", { path: "notes/raw/a.txt", content: "hello tide" });
    await execute("copy_path", { from: "notes", to: "backup/notes", recursive: true });
    assert.equal(
      await readFile(path.join(directory, "backup", "notes", "raw", "a.txt"), "utf8"),
      "hello tide",
    );

    await execute("move_path", {
      from: "backup/notes/raw/a.txt",
      to: "archive/a.txt",
    });
    assert.equal(await readFile(path.join(directory, "archive", "a.txt"), "utf8"), "hello tide");

    await execute("delete_path", { path: "notes", recursive: true });
    await execute("delete_path", { path: "backup", recursive: true });

    const rootDelete = await executor.executeOne({
      type: "tool_call",
      id: "call-root-delete",
      name: "delete_path",
      input: { path: ".", recursive: true },
    });
    assert.equal(rootDelete.isError, true);
    assert.match(rootDelete.output, /workspace root/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
