import { Transform } from "node:stream";
import { createInterface, type Interface } from "node:readline/promises";
import type { ReadStream } from "node:tty";
import type { Writable } from "node:stream";

// 终端「括号粘贴」(bracketed paste) 协议：开启后，终端会把整段粘贴用
// ESC[200~ ... ESC[201~ 包起来，应用据此识别粘贴边界——把里面的换行当成普通
// 字符，而不是逐行提交。绝大多数现代终端（Windows Terminal、iTerm2、各 Linux 终端）
// 都支持；不支持的终端会静默忽略这两个开关序列，于是行为回退到「逐行读取」，没有回归。
const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// 用私有使用区(PUA)字符占位粘贴内容里的换行：readline 把它当普通可打印字符，
// 不会触发提交；用户真正按下回车（在粘贴标记之外）才提交。提交后用
// decodePastedInput 把占位符换回真正的 \n，从而保留多行结构。
export const PASTE_NEWLINE = "";

/** 把一行里粘贴产生的换行占位符还原成真正的换行。 */
export function decodePastedInput(line: string): string {
  return line.includes(PASTE_NEWLINE) ? line.split(PASTE_NEWLINE).join("\n") : line;
}

/**
 * 计算 s 末尾「同时是 marker 前缀」的最长长度，用于把可能被 chunk 边界截断的
 * 转义序列（如刚好停在 `\x1b[20`）留到下一块再判定，避免误判或漏判。
 */
function trailingMarkerPrefixLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

/** 粘贴正文内的换行 → 占位符；其余字符原样保留。 */
function sanitizePasteBody(body: string): string {
  return body.replace(/\r\n|\r|\n/g, PASTE_NEWLINE);
}

/**
 * 创建一个 Transform：剥离括号粘贴标记，并把粘贴正文里的换行替换成占位符。
 * 非粘贴内容（含用户逐字输入、方向键等转义序列）原样透传，交给 readline 正常处理。
 * 导出以便单测。
 */
export function createPasteTransform(): Transform {
  let inPaste = false;
  let leftover = "";
  return new Transform({
    decodeStrings: false,
    transform(chunk, _enc, cb) {
      let data = leftover + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      leftover = "";
      let out = "";
      while (data.length > 0) {
        if (!inPaste) {
          const idx = data.indexOf(PASTE_START);
          if (idx === -1) {
            // 没有起始标记：透传，但把末尾可能是「半个起始标记」的部分留到下一块。
            const hold = trailingMarkerPrefixLength(data, PASTE_START);
            out += data.slice(0, data.length - hold);
            leftover = data.slice(data.length - hold);
            break;
          }
          out += data.slice(0, idx);
          data = data.slice(idx + PASTE_START.length);
          inPaste = true;
        } else {
          const idx = data.indexOf(PASTE_END);
          if (idx === -1) {
            const hold = trailingMarkerPrefixLength(data, PASTE_END);
            out += sanitizePasteBody(data.slice(0, data.length - hold));
            leftover = data.slice(data.length - hold);
            break;
          }
          out += sanitizePasteBody(data.slice(0, idx));
          data = data.slice(idx + PASTE_END.length);
          inPaste = false;
        }
      }
      cb(null, out);
    },
  });
}

export interface InteractiveInterface {
  terminal: Interface;
  /**
   * 注册「中断键」(ESC) 监听，返回取消注册的函数。一般只在 agent 运行期间注册，
   * 让用户在模型思考/生成或工具执行时按 ESC 打断。非 TTY 下为无操作。
   */
  onInterrupt(handler: () => void): () => void;
  /** 还原终端状态：关粘贴模式、退出 raw 模式、断开管道、关闭 readline。 */
  dispose(): void;
}

/**
 * 构建可读多行粘贴的交互式输入接口。
 * - TTY：开启括号粘贴 + raw 模式，stdin → 粘贴 Transform → readline(terminal)，
 *   既能正确收下整段多行粘贴，又保留 readline 的历史/光标/行编辑能力。
 * - 非 TTY（管道/重定向）：退回普通逐行读取，不做任何终端控制。
 */
export function createInteractiveInterface(input: ReadStream, output: Writable): InteractiveInterface {
  if (!input.isTTY) {
    const terminal = createInterface({ input, output });
    return { terminal, onInterrupt: () => () => {}, dispose: () => terminal.close() };
  }

  input.setEncoding("utf8");
  const transform = createPasteTransform();
  input.pipe(transform);
  input.setRawMode(true);
  output.write(ENABLE_BRACKETED_PASTE);

  // input 不是 TTY（是 Transform），需显式 terminal:true 让 readline 仍走交互模式；
  // raw 模式由我们手动管理（readline 只会对 isTTY 的输入自动设 raw）。
  const terminal = createInterface({ input: transform, output, terminal: true });

  // ESC 中断检测挂在「原始 stdin」上，而不是 transform：transform 会把可能是粘贴起始
  // 标记前缀的前导 ESC 暂存，导致孤立 ESC 被延迟/吞掉。raw 模式下，单独按 ESC 会作为
  // 单个 "\x1b" 数据块到达，而方向键/粘贴标记是 "\x1b[" 开头的更长序列——据此区分。
  const onInterrupt = (handler: () => void): (() => void) => {
    const listener = (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s === "\x1b") handler();
    };
    input.on("data", listener);
    return () => {
      input.off("data", listener);
    };
  };

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    output.write(DISABLE_BRACKETED_PASTE);
    terminal.close();
    try {
      input.setRawMode(false);
    } catch {
      // 退出途中 stdin 可能已不可用，忽略。
    }
    input.unpipe(transform);
    input.pause();
  };
  return { terminal, onInterrupt, dispose };
}
