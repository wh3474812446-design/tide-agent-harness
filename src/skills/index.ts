import { EventBus } from "../events.js";
import type { Tool } from "../tools/tool.js";
import { ToolRegistry } from "../tools/tool.js";
import { installSkill } from "./installer.js";
import { loadSkills, type LoadedSkill } from "./skill-loader.js";
import { createSkillTool } from "./skill-tool.js";

export { loadSkills, parseSkillMarkdown } from "./skill-loader.js";
export { installSkill } from "./installer.js";
export type { LoadedSkill } from "./skill-loader.js";

export interface SetupSkillsOptions {
  skillsDir: string;
  events: EventBus;
  /** 是否注册 install_skill 工具（让模型自己装技能）。默认 true。 */
  allowInstall?: boolean;
}

export interface SetupSkillsResult {
  skills: LoadedSkill[];
  skipped: Array<{ dir: string; reason: string }>;
  skillsDir: string;
}

/**
 * 装配技能系统：加载 skillsDir 下的技能，注册 `skill`（按需加载指令）与
 * `install_skill`（从本地目录 / git URL 安装）两个工具。
 */
export async function setupSkills(
  registry: ToolRegistry,
  options: SetupSkillsOptions,
): Promise<SetupSkillsResult> {
  const { skills, skipped } = await loadSkills(options.skillsDir);

  for (const skill of skills) options.events.emit({ type: "skill.loaded", name: skill.name });

  // 有技能才注册 skill 调用工具（否则模型看到空工具没意义）。
  if (skills.length > 0) {
    registry.register(createSkillTool(skills, options.events), { skipOnConflict: true });
  }

  if (options.allowInstall !== false) {
    registry.register(createInstallSkillTool(options.skillsDir, options.events), {
      skipOnConflict: true,
    });
  }

  return { skills, skipped, skillsDir: options.skillsDir };
}

/**
 * `install_skill` 工具：从本地目录或 git URL 安装一个技能到 skillsDir。
 * 高风险（要联网 + 起子进程 git + 写盘），归类 execute。安装后下次启动即生效。
 */
function createInstallSkillTool(skillsDir: string, events: EventBus): Tool {
  return {
    name: "install_skill",
    description:
      "Install a skill into the local skills directory from a local folder path or a git URL " +
      "(https://..., git@..., or github:owner/repo). The source must contain a SKILL.md. " +
      "After installing, the skill becomes available the next time Tide starts.",
    risk: "execute",
    concurrencySafe: false,
    source: "skill",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          description: "Local directory path or git URL of the skill to install.",
        },
        overwrite: {
          type: "boolean",
          description: "Replace an already-installed skill with the same name. Default false.",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async execute(input) {
      const { source, overwrite } = input as { source: string; overwrite?: boolean };
      const result = await installSkill(source, skillsDir, { overwrite: overwrite === true });
      events.emit({ type: "skill.installed", name: result.name, source: result.source });
      return JSON.stringify(
        {
          installed: result.name,
          dir: result.dir,
          overwritten: result.overwritten,
          note: "Restart Tide to load this skill into the available skills list.",
        },
        null,
        2,
      );
    },
  };
}
