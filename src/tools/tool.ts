import type { JsonSchema, ModelToolDefinition, RiskLevel } from "../types.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: RiskLevel;
  concurrencySafe: boolean;
  execute(input: unknown, context: ToolContext): Promise<string>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ModelToolDefinition[] {
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
}

