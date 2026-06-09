import { EventBus } from "../events.js";
import type { Tool } from "../tools/tool.js";
import type { LoadedSkill } from "./skill-loader.js";

interface SkillToolInput {
  name: string;
}

/**
 * `skill` 工具：按需把某个技能的操作指令注入上下文（对照 Claude Code 的 SkillTool）。
 * - 工具描述里枚举所有可用技能（name: description），让模型自己挑。
 * - 调用时返回该技能 SKILL.md 正文，模型据此执行后续步骤。
 * 只读、可并发；技能正文可能较长，给 50k 字符上限。
 */
export function createSkillTool(skills: LoadedSkill[], events: EventBus): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const listing =
    skills.length > 0
      ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "(暂无已安装技能)";

  return {
    name: "skill",
    description:
      "Load and follow an installed skill's instructions. Use when a request matches one of the available skills below. " +
      "Calling this returns the skill's full instructions; then carry them out.\n\nAvailable skills:\n" +
      listing,
    risk: "read",
    concurrencySafe: true,
    source: "skill",
    maxResultChars: 50000,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The exact name of the skill to load.",
          enum: skills.length > 0 ? skills.map((s) => s.name) : undefined,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input) {
      const { name } = input as SkillToolInput;
      const skill = byName.get(name);
      if (!skill) {
        const names = [...byName.keys()].join(", ") || "(none)";
        throw new Error(`Unknown skill: ${name}. Available skills: ${names}`);
      }
      events.emit({ type: "skill.invoked", name });
      return [
        `# Skill: ${skill.name}`,
        `Skill directory: ${skill.dir}`,
        "",
        skill.body,
      ].join("\n");
    },
  };
}
