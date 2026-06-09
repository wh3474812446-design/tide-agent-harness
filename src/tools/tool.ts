import type { JsonSchema, ModelToolDefinition, RiskLevel } from "../types.js";

/** 检查点备份接口：文件工具改动前调用，记录原始内容以便回滚。 */
export interface CheckpointBackup {
  backup(absolutePath: string): Promise<void>;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** 可选：改动文件前用它备份原内容，供 /rewind 回滚。 */
  checkpoint?: CheckpointBackup;
}

/** 工具来源标签，用于状态展示与可观测性（对照 Claude Code 的 built-in / mcp / 动态加载分类）。 */
export type ToolSource = "builtin" | "api" | "mcp" | "skill";

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: RiskLevel;
  concurrencySafe: boolean;
  execute(input: unknown, context: ToolContext): Promise<string>;
  /**
   * 可选：执行前生成给用户看的预览（如写/改文件的 diff），用于审批界面。
   * 对照 Claude Code 编辑前展示 diff 的体验。内部应吞掉异常返回 undefined，不影响执行。
   */
  preview?(input: unknown, context: ToolContext): Promise<string | undefined>;
  /** 工具来源标签（可选，默认 builtin）。 */
  source?: ToolSource;
  /**
   * 该工具结果的最大字符数（可选）。超过则被执行器截断，覆盖全局上限。
   * 对照 Claude Code 的 maxResultSizeChars —— MCP / 联网工具可能返回巨大载荷，
   * 单独收紧能防止一次调用撑爆上下文。
   */
  maxResultChars?: number;
}

export interface RegisterOptions {
  /** 名称冲突时跳过并返回 false，而不是抛错（动态注册 MCP / Skill 工具时用）。 */
  skipOnConflict?: boolean;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  /**
   * 注册一个工具。默认名称冲突即抛错（内置工具的契约）。
   * 传 skipOnConflict 时，冲突则跳过并返回 false —— 供 MCP / Skill 动态批量注册，
   * 保证一个坏工具不拖垮整批。
   */
  register(tool: Tool, options: RegisterOptions = {}): boolean {
    if (this.#tools.has(tool.name)) {
      if (options.skipOnConflict) return false;
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return true;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 按来源统计已注册工具数量，用于启动状态展示。 */
  countBySource(): Record<ToolSource, number> {
    const counts: Record<ToolSource, number> = { builtin: 0, api: 0, mcp: 0, skill: 0 };
    for (const tool of this.#tools.values()) counts[tool.source ?? "builtin"] += 1;
    return counts;
  }

  definitions(): ModelToolDefinition[] {
    return this.list().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }
}
