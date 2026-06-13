import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ReadStream } from "node:tty";
import {
  createInteractiveInterface,
  createPasteTransform,
  decodePastedInput,
  PASTE_NEWLINE,
} from "../src/cli/paste-input.js";

const NL = PASTE_NEWLINE;
const START = "\x1b[200~";
const END = "\x1b[201~";

/** 把若干 chunk 依次写入粘贴 Transform，收集全部输出。 */
function runTransform(chunks: string[]): Promise<string> {
  const transform = createPasteTransform();
  const out: string[] = [];
  transform.on("data", (c: unknown) =>
    out.push(typeof c === "string" ? c : (c as Buffer).toString("utf8")),
  );
  return new Promise((resolve, reject) => {
    transform.on("end", () => resolve(out.join("")));
    transform.on("error", reject);
    for (const ch of chunks) transform.write(ch);
    transform.end();
  });
}

test("括号粘贴的多行内容被合成一行：换行换成占位符、标记被剥离", async () => {
  const out = await runTransform([`${START}line1\nline2\nline3${END}`]);
  assert.equal(out, `line1${NL}line2${NL}line3`);
  // 占位符还原后恢复成真正的多行文本。
  assert.equal(decodePastedInput(out), "line1\nline2\nline3");
});

test("粘贴外的真实换行原样透传（即用户回车提交）", async () => {
  const out = await runTransform(["hello\n"]);
  assert.equal(out, "hello\n");
});

test("打字与粘贴混合：仅粘贴段内换行被占位，段外回车保留", async () => {
  const out = await runTransform([`hi ${START}x\ny${END} end\n`]);
  assert.equal(out, `hi x${NL}y end\n`);
  assert.equal(decodePastedInput(out), "hi x\ny end\n");
});

test("CRLF 粘贴换行被规整为单个占位符", async () => {
  const out = await runTransform([`${START}a\r\nb${END}`]);
  assert.equal(out, `a${NL}b`);
});

test("起始/结束标记被 chunk 边界截断也能正确识别", async () => {
  // 起始标记拆成 "\x1b[2" + "00~"，结束标记拆成 "\x1b[20" + "1~"。
  const out = await runTransform(["\x1b[2", "00~hi\nyo\x1b[20", "1~"]);
  assert.equal(out, `hi${NL}yo`);
});

test("粘贴正文跨多个 chunk 累积", async () => {
  const out = await runTransform([`${START}aaa\n`, "bbb\n", `ccc${END}`]);
  assert.equal(out, `aaa${NL}bbb${NL}ccc`);
});

test("含中文与表情的多行粘贴不丢字、不串行", async () => {
  const body = "第一行：你好\n第二行：世界 \n第三行：JSON 数组";
  const out = await runTransform([`${START}${body}${END}\n`]);
  assert.equal(decodePastedInput(out), `${body}\n`);
});

test("decodePastedInput 对无占位符的普通行原样返回", () => {
  assert.equal(decodePastedInput("just one line"), "just one line");
});

/** 伪造一个 TTY 风格的 stdin：PassThrough + isTTY + setRawMode 桩。 */
function fakeTtyStdin(): PassThrough {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("onInterrupt 检测孤立 ESC，忽略方向键与粘贴标记，注销后不再触发", async () => {
  const input = fakeTtyStdin();
  const output = new Writable({ write(_c, _e, cb) { cb(); } });
  const io = createInteractiveInterface(input as unknown as ReadStream, output);
  let escapes = 0;
  const stop = io.onInterrupt(() => { escapes += 1; });

  input.write("\x1b[A"); // 方向键上
  input.write("\x1b[200~hi\x1b[201~"); // 一段粘贴
  await tick();
  assert.equal(escapes, 0, "方向键与粘贴标记不应被当作中断");

  input.write("\x1b"); // 孤立 ESC
  await tick();
  assert.equal(escapes, 1, "孤立 ESC 应触发中断");

  stop();
  input.write("\x1b");
  await tick();
  assert.equal(escapes, 1, "注销监听后 ESC 不应再触发");

  io.dispose();
});
