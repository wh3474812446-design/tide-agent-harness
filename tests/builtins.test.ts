import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { grepTool } from "../src/tools/builtins/grep.js";
import { globTool } from "../src/tools/builtins/glob.js";
import { readFileTool } from "../src/tools/builtins/read-file.js";
import { runCommandTool } from "../src/tools/builtins/run-command.js";
import { getCommandOutputTool } from "../src/tools/builtins/get-command-output.js";

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tide-builtins-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const greet = () => 'hello world';\n", "utf8");
  await writeFile(path.join(dir, "src", "b.ts"), "// no match here\nconst x = 1;\n", "utf8");
  await writeFile(path.join(dir, "notes.md"), "line one\nline two\nline three\n", "utf8");
  return dir;
}

function ctx(cwd: string) {
  return { cwd, signal: new AbortController().signal };
}

test("grep finds matching lines with path:line prefix", async () => {
  const dir = await makeWorkspace();
  const out = await grepTool.execute({ pattern: "hello world" }, ctx(dir));
  assert.match(out, /a\.ts:1/);
  assert.match(out, /hello world/);
});

test("grep with glob filter limits to matching files", async () => {
  const dir = await makeWorkspace();
  const out = await grepTool.execute({ pattern: "const", glob: "*.ts" }, ctx(dir));
  assert.match(out, /b\.ts/);
  assert.doesNotMatch(out, /notes\.md/);
});

test("grep reports no matches cleanly", async () => {
  const dir = await makeWorkspace();
  const out = await grepTool.execute({ pattern: "zzz-nonexistent-zzz" }, ctx(dir));
  assert.match(out, /No matches/);
});

test("glob matches by pattern and returns relative paths", async () => {
  const dir = await makeWorkspace();
  const out = await globTool.execute({ pattern: "**/*.ts" }, ctx(dir));
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /src\/b\.ts/);
  assert.doesNotMatch(out, /notes\.md/);
});

test("read_file prefixes line numbers and supports offset/limit", async () => {
  const dir = await makeWorkspace();
  const full = await readFileTool.execute({ path: "notes.md" }, ctx(dir));
  assert.match(full, /1\tline one/);
  assert.match(full, /3\tline three/);

  const slice = await readFileTool.execute({ path: "notes.md", offset: 2, limit: 1 }, ctx(dir));
  assert.match(slice, /2\tline two/);
  assert.doesNotMatch(slice, /line one/);
});

test("run_command in background returns a job id, get_command_output reads it", async () => {
  const dir = await makeWorkspace();
  const started = await runCommandTool.execute(
    { command: process.platform === "win32" ? "echo hi" : "echo hi", run_in_background: true },
    ctx(dir),
  );
  const match = started.match(/bg-\d+-[a-z0-9]+/);
  assert.ok(match, "should return a background job id");
  const id = match![0];

  // 轮询直到任务结束（最多 ~2s）。
  let out = "";
  for (let i = 0; i < 20; i++) {
    out = await getCommandOutputTool.execute({ id, onlyNew: false }, ctx(dir));
    if (/已结束/.test(out)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(out, /hi/);
  assert.match(out, /已结束/);
});
