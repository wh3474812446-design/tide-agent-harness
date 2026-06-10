import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { readFile as readFileFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileTool } from "../src/tools/builtins/read-file.js";
import { replaceInFileTool } from "../src/tools/builtins/replace-in-file.js";
import { writeFileTool } from "../src/tools/builtins/write-file.js";
import { applyReplaceWithCascade } from "../src/tools/builtins/edit-utils.js";
import { FileStateTracker } from "../src/tools/file-state.js";
import type { ToolContext } from "../src/tools/tool.js";

function ctx(cwd: string, fileState: FileStateTracker): ToolContext {
  return { cwd, signal: new AbortController().signal, fileState };
}

test("read-before-edit contract: unread file is rejected, read file is editable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-contract-"));
  const fileState = new FileStateTracker();
  const context = ctx(dir, fileState);
  await writeFile(path.join(dir, "a.ts"), 'const a = "x";\n', "utf8");

  // 没读过 → 拒绝。
  await assert.rejects(
    replaceInFileTool.execute({ path: "a.ts", search: '"x"', replacement: '"z"' }, context),
    /read_file/,
  );
  // 覆盖写同样拒绝。
  await assert.rejects(writeFileTool.execute({ path: "a.ts", content: "anything" }, context), /read_file/);

  // 读过 → 放行。
  await readFileTool.execute({ path: "a.ts" }, context);
  const out = await replaceInFileTool.execute({ path: "a.ts", search: '"x"', replacement: '"z"' }, context);
  assert.match(out, /Replaced one occurrence/);
  assert.equal(await readFileFs(path.join(dir, "a.ts"), "utf8"), 'const a = "z";\n');

  // 新建文件不受限。
  const created = await writeFileTool.execute({ path: "new.txt", content: "fresh" }, context);
  assert.match(created, /Wrote/);
});

test("read-before-edit contract: external modification forces a re-read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-stale-"));
  const fileState = new FileStateTracker();
  const context = ctx(dir, fileState);
  const filePath = path.join(dir, "b.ts");
  await writeFile(filePath, "original\n", "utf8");

  await readFileTool.execute({ path: "b.ts" }, context);
  // 模拟外部改动：内容变了且 mtime 前移。
  await writeFile(filePath, "changed outside\n", "utf8");
  const future = new Date(Date.now() + 5000);
  await utimes(filePath, future, future);

  await assert.rejects(
    replaceInFileTool.execute({ path: "b.ts", search: "changed", replacement: "edited" }, context),
    /外部修改/,
  );

  // 重新读过 → 放行；编辑后连续编辑不需要再读。
  await readFileTool.execute({ path: "b.ts" }, context);
  await replaceInFileTool.execute({ path: "b.ts", search: "changed", replacement: "edited" }, context);
  await replaceInFileTool.execute({ path: "b.ts", search: "edited", replacement: "edited twice" }, context);
  assert.equal(await readFileFs(filePath, "utf8"), "edited twice outside\n");
});

test("edit cascade: trailing whitespace and CRLF differences are tolerated", () => {
  const content = "function f() {  \r\n  return 1;\t\r\n}\r\n";
  const applied = applyReplaceWithCascade(content, "function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}", false);
  assert.equal(applied.matcher, "whitespace");
  assert.match(applied.content, /return 2/);
});

test("edit cascade: curly quotes are normalized for matching, file text wins", () => {
  const content = 'console.log("hello");\n';
  const applied = applyReplaceWithCascade(content, "console.log(“hello”);", 'console.log("bye");', false);
  assert.equal(applied.matcher, "quotes");
  assert.equal(applied.content, 'console.log("bye");\n');
});

test("edit cascade: read_file line-number prefixes are stripped", () => {
  const content = "alpha\nbeta\ngamma\n";
  const applied = applyReplaceWithCascade(content, "1\talpha\n2\tbeta\n", "ALPHA\nbeta\n", false);
  assert.match(applied.matcher, /^line-numbers\+/);
  assert.equal(applied.content, "ALPHA\nbeta\ngamma\n");
});

test("edit cascade: multiple matches need replace_all; replace_all replaces every one", () => {
  const content = "id = a1; x = a1; y = a1;\n";
  assert.throws(() => applyReplaceWithCascade(content, "a1", "b2", false), /replace_all/);
  const applied = applyReplaceWithCascade(content, "a1", "b2", true);
  assert.equal(applied.replacedCount, 3);
  assert.equal(applied.content, "id = b2; x = b2; y = b2;\n");
});

test("edit cascade: identical search and replacement is rejected", () => {
  assert.throws(() => applyReplaceWithCascade("abc\n", "abc", "abc", false), /相同/);
});
