import AjvImport, { type ErrorObject, type ValidateFunction } from "ajv";
import { EventBus } from "../events.js";
import { RiskPolicy } from "../policy/policy.js";
import type { ToolCallBlock, ToolResultBlock } from "../types.js";
import type { Tool } from "./tool.js";
import { ToolRegistry } from "./tool.js";

interface ToolExecutorOptions {
  cwd: string;
  registry: ToolRegistry;
  policy: RiskPolicy;
  events?: EventBus;
  timeoutMs?: number;
  maxOutputChars?: number;
}

interface AjvInstance {
  compile(schema: object): ValidateFunction;
  errorsText(errors?: ErrorObject[] | null): string;
}

const Ajv = AjvImport as unknown as new (options?: Record<string, unknown>) => AjvInstance;

export class ToolExecutor {
  readonly #cwd: string;
  readonly #registry: ToolRegistry;
  readonly #policy: RiskPolicy;
  readonly #events: EventBus;
  readonly #timeoutMs: number;
  readonly #maxOutputChars: number;
  readonly #ajv = new Ajv({ allErrors: true, strict: false });
  readonly #validators = new Map<string, ValidateFunction>();

  constructor(options: ToolExecutorOptions) {
    this.#cwd = options.cwd;
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#events = options.events ?? new EventBus();
    this.#timeoutMs = options.timeoutMs ?? 60000;
    this.#maxOutputChars = options.maxOutputChars ?? 30000;
  }

  async executeAll(calls: ToolCallBlock[], parentSignal?: AbortSignal): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let safeBatch: ToolCallBlock[] = [];

    const flushSafeBatch = async () => {
      if (safeBatch.length === 0) return;
      results.push(...(await Promise.all(safeBatch.map((call) => this.executeOne(call, parentSignal)))));
      safeBatch = [];
    };

    for (const call of calls) {
      const tool = this.#registry.get(call.name);
      if (tool?.concurrencySafe) {
        safeBatch.push(call);
      } else {
        await flushSafeBatch();
        results.push(await this.executeOne(call, parentSignal));
      }
    }
    await flushSafeBatch();
    return results;
  }

  async executeOne(call: ToolCallBlock, parentSignal?: AbortSignal): Promise<ToolResultBlock> {
    this.#events.emit({ type: "tool.started", id: call.id, name: call.name });
    try {
      const tool = this.#registry.get(call.name);
      if (!tool) throw new Error(`Unknown tool: ${call.name}`);
      this.#validate(tool, call.input);
      const decision = await this.#policy.decide(tool, call.input);
      if (!decision.allowed) throw new Error(`Permission denied: ${decision.reason}`);
      const output = await this.#runWithTimeout(tool, call.input, parentSignal);
      const result = this.#result(call, this.#truncate(output, tool.maxResultChars), false);
      this.#events.emit({ type: "tool.finished", id: call.id, name: call.name, isError: false });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = this.#result(call, this.#truncate(message), true);
      this.#events.emit({ type: "tool.finished", id: call.id, name: call.name, isError: true });
      return result;
    }
  }

  #validate(tool: Tool, input: unknown): void {
    const cached = this.#validators.get(tool.name);
    const validator = cached ?? this.#ajv.compile(tool.inputSchema);
    if (!cached) {
      this.#validators.set(tool.name, validator);
    }
    if (!validator(input)) {
      throw new Error(`Invalid input for ${tool.name}: ${this.#ajv.errorsText(validator.errors)}`);
    }
  }

  async #runWithTimeout(tool: Tool, input: unknown, parentSignal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Tool timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
    timer.unref();

    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error("Tool aborted.")),
          { once: true },
        );
      });
      return await Promise.race([
        tool.execute(input, { cwd: this.#cwd, signal: controller.signal }),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  /** 截断超长工具输出。每个工具可用 maxResultChars 覆盖全局上限（取两者较小值）。 */
  #truncate(output: string, toolLimit?: number): string {
    const limit =
      toolLimit && toolLimit > 0 ? Math.min(toolLimit, this.#maxOutputChars) : this.#maxOutputChars;
    if (output.length <= limit) return output;
    const half = Math.floor(limit / 2);
    return `${output.slice(0, half)}\n\n[... ${output.length - limit} characters omitted ...]\n\n${output.slice(-half)}`;
  }

  #result(call: ToolCallBlock, output: string, isError: boolean): ToolResultBlock {
    return {
      type: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      output,
      isError,
    };
  }
}
