/**
 * 极简差异展示工具，用于编辑审批时给用户看改动（对照 Claude Code 的编辑 diff 预览）。
 * 不做完整 LCS，只把删除行标 `-`、新增行标 `+`，够审批判断用。
 */

const MAX_LINES = 60;

/** 替换式编辑的预览：search → replacement。 */
export function formatReplaceDiff(filePath: string, search: string, replacement: string): string {
  const minus = clip(search.split("\n")).map((l) => `- ${l}`);
  const plus = clip(replacement.split("\n")).map((l) => `+ ${l}`);
  return `编辑 ${filePath}\n${minus.join("\n")}\n${plus.join("\n")}`;
}

/** 整文件写入的预览：新建或覆盖。 */
export function formatWriteDiff(filePath: string, existing: string | null, next: string): string {
  const nextLines = next.split("\n");
  if (existing === null) {
    const head = clip(nextLines).map((l) => `+ ${l}`);
    return `新建 ${filePath}（${nextLines.length} 行）\n${head.join("\n")}`;
  }
  const oldLines = existing.split("\n");
  // 简单首尾共同前缀/后缀剥离，只展示中间变化段
  let start = 0;
  while (start < oldLines.length && start < nextLines.length && oldLines[start] === nextLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = nextLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === nextLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = clip(oldLines.slice(start, endOld + 1)).map((l) => `- ${l}`);
  const added = clip(nextLines.slice(start, endNew + 1)).map((l) => `+ ${l}`);
  const ctx = start > 0 ? `  …（前 ${start} 行未变）\n` : "";
  if (removed.length === 0 && added.length === 0) return `覆盖 ${filePath}（内容无变化）`;
  return `覆盖 ${filePath}（旧 ${oldLines.length} 行 → 新 ${nextLines.length} 行）\n${ctx}${removed.join("\n")}${removed.length ? "\n" : ""}${added.join("\n")}`;
}

function clip(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `…（省略 ${lines.length - MAX_LINES} 行）`];
}
