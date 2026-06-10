import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setupMemory } from "../src/app/memory.js";
import { buildSystemPrompt } from "../src/app/system-prompt.js";

test("setupMemory creates the memory dir and MEMORY.md template on first run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tide-mem-"));
  const memory = await setupMemory(root);
  assert.ok(memory);
  assert.equal(memory.dir, path.join(root, "memory"));
  const index = await readFile(path.join(memory.dir, "MEMORY.md"), "utf8");
  assert.match(index, /永久记忆索引/);
  assert.match(memory.index, /永久记忆索引/);
});

test("setupMemory loads an existing index without overwriting it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tide-mem2-"));
  const first = await setupMemory(root);
  assert.ok(first);
  await writeFile(
    path.join(first.dir, "MEMORY.md"),
    "# Tide 永久记忆索引\n\n- [用户偏好](user_pref.md) — 喜欢简体中文回复\n",
    "utf8",
  );
  const second = await setupMemory(root);
  assert.ok(second);
  assert.match(second.index, /用户偏好/);
  // 没有被模板覆盖。
  const onDisk = await readFile(path.join(second.dir, "MEMORY.md"), "utf8");
  assert.match(onDisk, /user_pref\.md/);
});

test("buildSystemPrompt injects the memory section with dir and index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tide-mem3-"));
  const memory = await setupMemory(root);
  assert.ok(memory);
  const prompt = buildSystemPrompt("C:\\ws", [], null, "test-model", memory);
  assert.match(prompt, /# 永久记忆/);
  assert.ok(prompt.includes(memory.dir));
  assert.match(prompt, /MEMORY\.md/);
  // 没传 memory 时不出现该节。
  const without = buildSystemPrompt("C:\\ws", [], null, "test-model", null);
  assert.doesNotMatch(without, /# 永久记忆/);
});
