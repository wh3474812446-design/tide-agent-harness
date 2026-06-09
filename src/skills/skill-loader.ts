import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 一个 Skill = 目录下含 `SKILL.md` 的文件夹（与 Claude Code / Anthropic skills 同构）。
 * SKILL.md 用 YAML frontmatter 声明 name / description，其余正文是给模型的操作指令。
 *   ---
 *   name: my-skill
 *   description: 一句话说明何时用
 *   ---
 *   正文：步骤、约定、示例……
 */
export interface LoadedSkill {
  name: string;
  description: string;
  /** 技能目录绝对路径，供正文里引用相对文件。 */
  dir: string;
  /** SKILL.md frontmatter 之后的正文（指令本体）。 */
  body: string;
}

export interface SkillLoadResult {
  skills: LoadedSkill[];
  /** 跳过的目录及原因（无 SKILL.md、frontmatter 缺字段等），用于状态展示。 */
  skipped: Array<{ dir: string; reason: string }>;
}

/** 扫描 skills 根目录，加载所有合法技能。目录不存在时返回空结果（非错误）。 */
export async function loadSkills(skillsDir: string): Promise<SkillLoadResult> {
  const skills: LoadedSkill[] = [];
  const skipped: Array<{ dir: string; reason: string }> = [];

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { skills, skipped };
    throw error;
  }

  for (const entry of entries.sort()) {
    const dir = path.join(skillsDir, entry);
    let isDir = false;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const loaded = await loadSkillFromDir(dir);
    if ("reason" in loaded) skipped.push({ dir, reason: loaded.reason });
    else skills.push(loaded);
  }

  // 名称冲突：保留先出现的（字母序靠前），后者记为跳过。
  const seen = new Set<string>();
  const deduped: LoadedSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      skipped.push({ dir: skill.dir, reason: `duplicate skill name: ${skill.name}` });
      continue;
    }
    seen.add(skill.name);
    deduped.push(skill);
  }

  return { skills: deduped, skipped };
}

/** 从单个目录加载一个技能；不合法时返回 { reason }。 */
export async function loadSkillFromDir(
  dir: string,
): Promise<LoadedSkill | { reason: string }> {
  const skillFile = path.join(dir, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { reason: "no SKILL.md" };
    throw error;
  }

  const parsed = parseSkillMarkdown(content);
  if (!parsed.name) return { reason: "SKILL.md frontmatter missing name" };
  if (!parsed.description) return { reason: "SKILL.md frontmatter missing description" };
  if (!/^[a-zA-Z0-9_-]+$/.test(parsed.name)) {
    return { reason: `invalid skill name: ${parsed.name}` };
  }

  return { name: parsed.name, description: parsed.description, dir, body: parsed.body };
}

interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
}

/** 解析 SKILL.md：抽出 `--- ... ---` frontmatter 的 name/description，其余为正文。 */
export function parseSkillMarkdown(content: string): ParsedSkill {
  const normalized = content.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: normalized.trim() };

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv?.[1]) continue;
    fields[kv[1].toLowerCase()] = unquote((kv[2] ?? "").trim());
  }
  return { name: fields.name, description: fields.description, body };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
