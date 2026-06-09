import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 工作区检查点（对照 Claude Code 的回滚/rewind）：在文件被改动前备份其原始内容，
 * 之后可一键还原到上一个检查点之前的状态。进程内存储 —— 用于一次会话内的“撤销我刚才那条请求的改动”。
 */
interface FileBackup {
  absolutePath: string;
  existedBefore: boolean;
  content: string | null;
}

interface Checkpoint {
  label: string;
  createdAt: number;
  files: Map<string, FileBackup>;
}

export class CheckpointStore {
  readonly #stack: Checkpoint[] = [];

  /** 开一个新检查点（通常每条用户消息前调用一次）。 */
  begin(label: string): void {
    this.#stack.push({ label: label.slice(0, 80), createdAt: Date.now(), files: new Map() });
  }

  /** 在改动某文件前备份它的原始内容。同一检查点内同一文件只备份首次。 */
  async backup(absolutePath: string): Promise<void> {
    const current = this.#stack[this.#stack.length - 1];
    if (!current) return; // 没有活动检查点就不记录
    const key = path.resolve(absolutePath);
    if (current.files.has(key)) return;
    let content: string | null = null;
    let existedBefore = false;
    try {
      content = await readFile(key, "utf8");
      existedBefore = true;
    } catch {
      existedBefore = false;
    }
    current.files.set(key, { absolutePath: key, existedBefore, content });
  }

  hasCheckpoints(): boolean {
    return this.#stack.length > 0;
  }

  /** 还原最近一个有改动的检查点：恢复被改文件、删除新建文件。 */
  async rewindLast(): Promise<{ label: string; restored: number } | null> {
    // 跳过没有任何文件改动的空检查点
    while (this.#stack.length > 0) {
      const cp = this.#stack.pop()!;
      if (cp.files.size === 0) continue;
      let restored = 0;
      for (const f of cp.files.values()) {
        try {
          if (f.existedBefore && f.content !== null) {
            await mkdir(path.dirname(f.absolutePath), { recursive: true });
            await writeFile(f.absolutePath, f.content, "utf8");
          } else {
            // 改动前不存在 → 是新建的，删掉
            await rm(f.absolutePath, { force: true });
          }
          restored += 1;
        } catch {
          // 单个文件还原失败不影响其余
        }
      }
      return { label: cp.label, restored };
    }
    return null;
  }
}
