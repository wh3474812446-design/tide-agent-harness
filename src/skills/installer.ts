import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadSkillFromDir } from "./skill-loader.js";

const execFileAsync = promisify(execFile);

export interface InstallSkillOptions {
  /** 已存在同名技能时是否覆盖（默认 false：报错让用户确认）。 */
  overwrite?: boolean;
  /** git clone 超时（毫秒），默认 120000。 */
  gitTimeoutMs?: number;
}

export interface InstallSkillResult {
  name: string;
  dir: string;
  source: string;
  overwritten: boolean;
}

/**
 * 把一个技能安装进 skillsDir。来源支持：
 *  - 本地目录：含 SKILL.md 的文件夹 → 递归复制。
 *  - git URL：git clone（浅克隆）后取根目录 SKILL.md。
 * 安装后以 SKILL.md frontmatter 里的 name 作为目标文件夹名。
 */
export async function installSkill(
  source: string,
  skillsDir: string,
  options: InstallSkillOptions = {},
): Promise<InstallSkillResult> {
  await mkdir(skillsDir, { recursive: true });

  if (isGitSource(source)) {
    return await installFromGit(source, skillsDir, options);
  }
  return await installFromLocalDir(source, skillsDir, options, source);
}

function isGitSource(source: string): boolean {
  return (
    /^https?:\/\/.+/.test(source) ||
    source.startsWith("git@") ||
    source.endsWith(".git") ||
    source.startsWith("github:")
  );
}

async function installFromGit(
  source: string,
  skillsDir: string,
  options: InstallSkillOptions,
): Promise<InstallSkillResult> {
  const url = source.startsWith("github:")
    ? `https://github.com/${source.slice("github:".length)}.git`
    : source;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "tide-skill-"));
  const clonePath = path.join(tempRoot, "repo");
  try {
    await execFileAsync("git", ["clone", "--depth", "1", url, clonePath], {
      timeout: options.gitTimeoutMs ?? 120000,
      windowsHide: true,
    });
    return await installFromLocalDir(clonePath, skillsDir, options, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git clone failed for ${url}: ${message}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installFromLocalDir(
  sourceDir: string,
  skillsDir: string,
  options: InstallSkillOptions,
  originalSource: string,
): Promise<InstallSkillResult> {
  const resolved = path.resolve(sourceDir);
  let isDir = false;
  try {
    isDir = (await stat(resolved)).isDirectory();
  } catch {
    throw new Error(`Skill source not found: ${resolved}`);
  }
  if (!isDir) throw new Error(`Skill source must be a directory containing SKILL.md: ${resolved}`);

  const loaded = await loadSkillFromDir(resolved);
  if ("reason" in loaded) {
    throw new Error(`Not a valid skill (${loaded.reason}): ${resolved}`);
  }

  const target = path.join(skillsDir, loaded.name);
  const exists = await pathExists(target);
  if (exists && !options.overwrite) {
    throw new Error(`Skill "${loaded.name}" already installed at ${target}. Pass overwrite to replace.`);
  }
  if (exists) await rm(target, { recursive: true, force: true });

  await cp(resolved, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) });

  return { name: loaded.name, dir: target, source: originalSource, overwritten: exists };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
