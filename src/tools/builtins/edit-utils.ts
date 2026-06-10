/**
 * replace_in_file 的容错匹配级联（对照 Claude Code FileEditTool/utils.ts 的
 * normalizeQuotes / stripTrailingWhitespace / findActualString）。
 *
 * 模型给的 search 文本经常「几乎正确」：行尾空白对不上、智能引号被转写、
 * 或者把 read_file 的行号前缀一起复制了进来。精确匹配直接失败会浪费一轮
 * 重读重试；这里按由严到宽的顺序尝试，并始终以「文件里的实际文本」为准替换，
 * 绝不把归一化后的文本写回文件。
 *
 * 级联顺序：
 *   1. exact            —— 精确子串
 *   2. whitespace       —— 行级比较，忽略行尾空白（顺带兼容 CRLF/LF 差异）
 *   3. quotes           —— 在 2 的基础上把智能引号归一成直引号、NBSP 归一成空格
 *   4. line-numbers     —— search 每行都带 read_file 的「行号+Tab」前缀时剥掉，再走 1~3
 */

export interface EditMatch {
  start: number;
  end: number;
  /** 文件中被命中的实际文本（用于 diff 展示与替换）。 */
  actual: string;
}

export interface CascadeResult {
  matches: EditMatch[];
  /** 命中的匹配器名；null 表示完全没找到。 */
  matcher: string | null;
}

export interface ApplyResult {
  content: string;
  replacedCount: number;
  matcher: string;
}

const LINE_NUMBER_PREFIX = /^\s*\d+\t/;

export function stripTrailingWhitespace(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

export function normalizeQuotes(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/ /g, " ");
}

/** 在文件内容里用级联匹配 search；返回全部非重叠命中与所用匹配器。 */
export function findWithCascade(content: string, search: string): CascadeResult {
  const exact = findExact(content, search);
  if (exact.length > 0) return { matches: exact, matcher: "exact" };

  const ws = findByLines(content, search, stripTrailingWhitespace);
  if (ws.length > 0) return { matches: ws, matcher: "whitespace" };

  const quotes = findByLines(content, search, (line) => normalizeQuotes(stripTrailingWhitespace(line)));
  if (quotes.length > 0) return { matches: quotes, matcher: "quotes" };

  // 行号前缀剥离：search 的每一行都形如「  12<TAB>代码」才触发，避免误伤真实内容。
  const searchLines = splitNeedleLines(search).lines;
  if (searchLines.length > 0 && searchLines.every((line) => LINE_NUMBER_PREFIX.test(line))) {
    const stripped =
      searchLines.map((line) => line.replace(LINE_NUMBER_PREFIX, "")).join("\n") +
      (search.endsWith("\n") ? "\n" : "");
    const inner = findWithCascade(content, stripped);
    if (inner.matcher !== null) {
      return { matches: inner.matches, matcher: `line-numbers+${inner.matcher}` };
    }
  }

  return { matches: [], matcher: null };
}

/**
 * 用级联匹配执行替换。多处命中且未指定 replaceAll 时抛错（带修复建议）；
 * 完全找不到时抛错并提示常见原因。
 */
export function applyReplaceWithCascade(
  content: string,
  search: string,
  replacement: string,
  replaceAll: boolean,
): ApplyResult {
  if (search === replacement) {
    throw new Error("search 和 replacement 完全相同，无需替换。请提供不同的新文本。");
  }

  const { matches, matcher } = findWithCascade(content, search);
  if (matcher === null || matches.length === 0) {
    throw new Error(
      "Search text was not found. 常见原因：文本与文件实际内容不一致（先 read_file 确认）、" +
        "复制时多了/少了行，或目标内容已被改过。请基于最新文件内容重试。",
    );
  }
  if (!replaceAll && matches.length > 1) {
    throw new Error(
      `Search text occurs ${matches.length} times; make it more specific. ` +
        "带上前后 3~5 行上下文让它唯一，或者（批量改名等场景）传 replace_all=true 一次全换。",
    );
  }

  const targets = replaceAll ? matches : matches.slice(0, 1);
  let result = "";
  let cursor = 0;
  for (const match of targets) {
    result += content.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  result += content.slice(cursor);
  return { content: result, replacedCount: targets.length, matcher };
}

/** 精确匹配的全部非重叠命中。 */
function findExact(content: string, search: string): EditMatch[] {
  const matches: EditMatch[] = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(search, from);
    if (index < 0) break;
    matches.push({ start: index, end: index + search.length, actual: search });
    from = index + search.length;
  }
  return matches;
}

interface NeedleLines {
  lines: string[];
  endsWithNewline: boolean;
}

/** 把 search 拆成行；末尾换行单独记录（决定命中区域是否吞掉行尾换行符）。 */
function splitNeedleLines(search: string): NeedleLines {
  const endsWithNewline = search.endsWith("\n");
  const body = endsWithNewline ? search.slice(0, -1) : search;
  return { lines: body.split("\n").map((line) => line.replace(/\r$/, "")), endsWithNewline };
}

interface FileLine {
  start: number;
  /** 行内容的结束偏移（不含换行符）。 */
  end: number;
  /** 含换行符的结束偏移（文件末行可能与 end 相同）。 */
  endWithNewline: number;
  text: string;
}

function splitFileLines(content: string): FileLine[] {
  const lines: FileLine[] = [];
  let start = 0;
  for (;;) {
    const nl = content.indexOf("\n", start);
    if (nl < 0) {
      lines.push({ start, end: content.length, endWithNewline: content.length, text: content.slice(start) });
      break;
    }
    const hasCr = nl > start && content[nl - 1] === "\r";
    lines.push({
      start,
      end: hasCr ? nl - 1 : nl,
      endWithNewline: nl + 1,
      text: content.slice(start, hasCr ? nl - 1 : nl),
    });
    start = nl + 1;
  }
  return lines;
}

/** 行级滑动窗口匹配：normalize 仅用于比较，命中区域取文件原文。 */
function findByLines(content: string, search: string, normalize: (line: string) => string): EditMatch[] {
  const needle = splitNeedleLines(search);
  if (needle.lines.length === 0) return [];
  const normalizedNeedle = needle.lines.map(normalize);
  const fileLines = splitFileLines(content);

  const matches: EditMatch[] = [];
  let index = 0;
  while (index <= fileLines.length - needle.lines.length) {
    let hit = true;
    for (let offset = 0; offset < normalizedNeedle.length; offset += 1) {
      if (normalize(fileLines[index + offset]!.text) !== normalizedNeedle[offset]) {
        hit = false;
        break;
      }
    }
    if (!hit) {
      index += 1;
      continue;
    }
    const first = fileLines[index]!;
    const last = fileLines[index + needle.lines.length - 1]!;
    // search 以换行结尾 → 命中区域也吞掉末行换行符，替换后不会多出空行。
    const end = needle.endsWithNewline ? last.endWithNewline : last.end;
    matches.push({ start: first.start, end, actual: content.slice(first.start, end) });
    index += needle.lines.length; // 非重叠推进
  }
  return matches;
}
