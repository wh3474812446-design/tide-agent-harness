import { EventBus } from "../events.js";
import type { JsonSchema, RiskLevel } from "../types.js";
import type { Tool } from "../tools/tool.js";
import type { SkillManager } from "./skill-manager.js";

interface SkillToolInput {
  name: string;
}

/**
 * `skill` 工具：按需把某个技能的操作指令注入上下文（对照 Claude Code 的 SkillTool）。
 * - description / inputSchema 用 getter 实时读取 SkillManager，使热安装的技能
 *   无需重启即可在下一回合被模型发现。
 * - 调用时返回该技能 SKILL.md 正文，模型据此执行后续步骤。
 * 只读、可并发；技能正文可能较长，给 50k 字符上限。
 */
export function createSkillTool(manager: SkillManager, events: EventBus): Tool {
  const risk: RiskLevel = "read";
  return {
    name: "skill",
    get description(): string {
      const skills = manager.list();
      const listing =
        skills.length > 0
          ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
          : "(no skills installed yet — use install_skill to add one)";
      return (
        "Load and follow an installed skill's instructions. Use when a request matches one of the " +
        "available skills below. Calling this returns the skill's full instructions; then carry them out.\n\n" +
        "Available skills:\n" +
        listing
      );
    },
    risk,
    concurrencySafe: true,
    source: "skill",
    maxResultChars: 50000,
    get inputSchema(): JsonSchema {
      const names = manager.list().map((s) => s.name);
      return {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The exact name of the skill to load.",
            ...(names.length > 0 ? { enum: names } : {}),
          },
        },
        required: ["name"],
        additionalProperties: false,
      };
    },
    async execute(input) {
      const { name } = input as SkillToolInput;
      const skill = manager.get(name);
      if (!skill) {
        const names = manager.list().map((s) => s.name).join(", ") || "(none)";
        throw new Error(`Unknown skill: ${name}. Available skills: ${names}`);
      }
      events.emit({ type: "skill.invoked", name });
      return [`# Skill: ${skill.name}`, `Skill directory: ${skill.dir}`, "", skill.body].join("\n");
    },
  };
}
