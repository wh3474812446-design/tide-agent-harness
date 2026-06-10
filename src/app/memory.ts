import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 永久记忆（对照 Claude Code 的 auto-memory）：
 *  - 固定目录 `<安装目录>/memory/`（HARNESS_MEMORY_DIR 可改），跨会话、跨工作区持久；
 *  - `MEMORY.md` 是索引（一条记忆一行），每条记忆是目录里的一个小 .md 文件；
 *  - 每次启动把索引注入系统提示，模型用现有的 read_file / write_file / replace_in_file
 *    就能查详情、写新记忆、改旧记忆——不需要任何新工具。
 *
 * 这解决「模型每次醒来都失忆、也看不到自己有哪些持久设定」的问题：
 * 用户说「记住 X」，模型写文件；下次对话开场索引就在上下文里。
 */

export interface MemoryContext {
  /** 记忆目录的绝对路径。 */
  dir: string;
  /** MEMORY.md 索引内容（已截断到注入上限）。 */
  index: string;
}

/** 注入系统提示的索引上限：索引应当一行一条，超过这个长度说明该整理了。 */
const INDEX_INJECT_MAX_CHARS = 8000;

const INDEX_TEMPLATE = `# Tide 永久记忆索引

（暂无记忆。每条记忆一行，格式：\`- [标题](文件名.md) — 一句话钩子\`；
记忆正文放在本目录的同名 .md 文件里，索引只放一行摘要。）
`;

/** 初始化记忆目录：确保目录与 MEMORY.md 存在，返回注入用的索引内容。失败时返回 null（非致命）。 */
export async function setupMemory(configRoot: string): Promise<MemoryContext | null> {
  try {
    const dir = process.env.HARNESS_MEMORY_DIR
      ? path.resolve(process.env.HARNESS_MEMORY_DIR)
      : path.join(configRoot, "memory");
    await mkdir(dir, { recursive: true });

    const indexPath = path.join(dir, "MEMORY.md");
    let index: string;
    try {
      index = await readFile(indexPath, "utf8");
    } catch {
      index = INDEX_TEMPLATE;
      await writeFile(indexPath, INDEX_TEMPLATE, "utf8");
    }

    const trimmed = index.trim();
    const injected =
      trimmed.length > INDEX_INJECT_MAX_CHARS
        ? `${trimmed.slice(0, INDEX_INJECT_MAX_CHARS)}\n…（索引过长已截断，请整理 MEMORY.md）`
        : trimmed;
    return { dir, index: injected };
  } catch {
    return null; // 记忆初始化失败不该让整个 Tide 起不来。
  }
}
