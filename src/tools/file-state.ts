import { stat } from "node:fs/promises";

/**
 * 读后改契约的文件状态追踪（对照 Claude Code 的 readFileState）：
 *  - read_file 成功后记录该文件的 mtime；
 *  - replace_in_file / write_file 修改「已存在的文件」前检查：必须读过，且读后没有被外部改动
 *   （用户、编辑器、linter……mtime 变了就要求重读）；
 *  - 写入成功后用新 mtime 更新记录，连续编辑同一文件不用反复重读。
 *
 * 防住两类事故：模型凭想象改没读过的文件；模型用过期内容覆盖别人刚改的文件。
 * 新建文件不受限制。可用 HARNESS_ENFORCE_READ_BEFORE_EDIT=0 整体关闭。
 */
export class FileStateTracker {
  readonly #records = new Map<string, number>();

  /** 记录一次成功读取（路径需为绝对路径）。 */
  async recordRead(absolutePath: string): Promise<void> {
    try {
      const info = await stat(absolutePath);
      this.#records.set(normalizeKey(absolutePath), info.mtimeMs);
    } catch {
      // 读 mtime 失败不致命：留空记录意味着后续编辑会要求重读，行为偏保守是安全的。
    }
  }

  /** 我们自己写入后调用：以最新 mtime 更新记录，使后续连续编辑不被拦。 */
  async recordWrite(absolutePath: string): Promise<void> {
    await this.recordRead(absolutePath);
  }

  /**
   * 编辑前检查。文件不存在 → 放行（新建）；没读过 → 报错；读后被外部改过 → 报错。
   * 返回 null 表示通过，否则返回应抛给模型的错误信息。
   */
  async checkBeforeEdit(absolutePath: string): Promise<string | null> {
    if (process.env.HARNESS_ENFORCE_READ_BEFORE_EDIT === "0") return null;

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absolutePath)).mtimeMs;
    } catch {
      return null; // 文件不存在：新建场景，放行。
    }

    const recorded = this.#records.get(normalizeKey(absolutePath));
    if (recorded === undefined) {
      return "该文件已存在但你还没读过它。先用 read_file 读取并理解现有内容，再做修改。";
    }
    if (mtimeMs > recorded) {
      return "该文件在你读取之后被外部修改过（用户、编辑器或 linter）。先用 read_file 重新读取最新内容，再基于它修改。";
    }
    return null;
  }
}

/** Windows 下盘符大小写、分隔符差异都可能造成 key 不一致，统一归一。 */
function normalizeKey(absolutePath: string): string {
  const unified = absolutePath.replace(/\//g, "\\");
  return process.platform === "win32" ? unified.toLowerCase() : absolutePath;
}
