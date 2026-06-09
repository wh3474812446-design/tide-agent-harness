import { EventBus } from "../events.js";
import { loadSkills, type LoadedSkill } from "./skill-loader.js";

/**
 * 持有当前已加载技能的可变容器，支持运行时 reload（热加载）。
 * skill 工具从这里读取列表，所以 install_skill 之后重新扫描目录即可让新技能
 * 在下一回合对模型可见，无需重启 —— 对照 Claude Code 的动态技能发现。
 */
export class SkillManager {
  #skills: LoadedSkill[];
  #skipped: Array<{ dir: string; reason: string }>;
  readonly #dir: string;
  readonly #events: EventBus;

  constructor(
    dir: string,
    initial: { skills: LoadedSkill[]; skipped: Array<{ dir: string; reason: string }> },
    events: EventBus,
  ) {
    this.#dir = dir;
    this.#skills = initial.skills;
    this.#skipped = initial.skipped;
    this.#events = events;
  }

  get dir(): string {
    return this.#dir;
  }

  list(): LoadedSkill[] {
    return this.#skills;
  }

  skipped(): Array<{ dir: string; reason: string }> {
    return this.#skipped;
  }

  get(name: string): LoadedSkill | undefined {
    return this.#skills.find((s) => s.name === name);
  }

  /** 重新扫描技能目录，更新内存列表。新出现的技能会触发 skill.loaded 事件。 */
  async reload(): Promise<LoadedSkill[]> {
    const known = new Set(this.#skills.map((s) => s.name));
    const result = await loadSkills(this.#dir);
    this.#skills = result.skills;
    this.#skipped = result.skipped;
    for (const skill of result.skills) {
      if (!known.has(skill.name)) this.#events.emit({ type: "skill.loaded", name: skill.name });
    }
    return this.#skills;
  }
}
