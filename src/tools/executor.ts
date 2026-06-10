import AjvImport, { type ErrorObject, type ValidateFunction } from "ajv";
import { EventBus } from "../events.js";
import { HookRunner } from "../hooks/hooks.js";
import { RiskPolicy } from "../policy/policy.js";
import type { ToolCallBlock, ToolResultBlock } from "../types.js";
import { FileStateTracker } from "./file-state.js";
import type { CheckpointBackup, Tool } from "./tool.js";
import { ToolRegistry } from "./tool.js";

interface ToolExecutorOptions {
  cwd: string;
  registry: ToolRegistry;
  policy: RiskPolicy;
  events?: EventBus;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** 可选 Hooks：工具执行前后跑命令；PreToolUse 非零退出可拦截。 */
  hooks?: HookRunner;
  /** 可选检查点：注入工具上下文，文件工具改动前备份原内容。 */
  checkpoint?: CheckpointBackup;
  /** 可选：读后改契约的文件状态追踪。主/子执行器传同一个实例即可共享状态；不传则自建。 */
  fileState?: FileStateTracker;
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
  readonly #hooks?: HookRunner;
  readonly #checkpoint?: CheckpointBackup;
  readonly #fileState: FileStateTracker;
  readonly #ajv = new Ajv({ allErrors: true, strict: false });
  readonly #validators = new Map<string, ValidateFunction>();

  constructor(options: ToolExecutorOptions) {
    this.#cwd = options.cwd;
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#events = options.events ?? new EventBus();
    // 默认 120s（旧 60s 太短）。run_command 等自管超时的工具用 tool.timeoutMs=0 豁免。
    this.#timeoutMs = options.timeoutMs ?? 120000;
    this.#maxOutputChars = options.maxOutputChars ?? 30000;
    this.#hooks = options.hooks;
    this.#checkpoint = options.checkpoint;
    this.#fileState = options.fileState ?? new FileStateTracker();
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

      // PreToolUse hook：可拦截工具调用。
      if (this.#hooks) {
        const pre = await this.#hooks.runPreToolUse(call.name, call.input);
        if (pre.block) throw new Error(pre.reason ?? `被 PreToolUse hook 拦截：${call.name}`);
      }

      // 审批前算预览（如编辑 diff），仅在需要审批时才值得算。
      const preview = await this.#preview(tool, call.input, parentSignal);
      const decision = await this.#policy.decide(tool, call.input, preview);
      if (!decision.allowed) throw new Error(`Permission denied: ${decision.reason}`);

      const output = await this.#runWithTimeout(tool, call.input, parentSignal);

      // PostToolUse hook：执行后跑命令（如自动 lint/格式化），失败不影响结果。
      if (this.#hooks) await this.#hooks.runPostToolUse(call.name, call.input, output);

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

  /** 调工具自带的 preview() 生成审批预览；不实现或出错则返回 undefined。 */
  async #preview(tool: Tool, input: unknown, parentSignal?: AbortSignal): Promise<string | undefined> {
    if (!tool.preview) return undefined;
    try {
      return await tool.preview(input, { cwd: this.#cwd, signal: parentSignal ?? new AbortController().signal });
    } catch {
      return undefined;
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
    // 工具可用 timeoutMs 覆盖全局默认；0 表示自管超时（不挂定时器，仍可被父 signal 中止）。
    const effectiveTimeout = tool.timeoutMs ?? this.#timeoutMs;
    const timer =
      effectiveTimeout > 0
        ? setTimeout(
            () => controller.abort(new Error(`Tool timed out after ${effectiveTimeout}ms`)),
            effectiveTimeout,
          )
        : undefined;
    timer?.unref();

    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error("Tool aborted.")),
          { once: true },
        );
      });
      return await Promise.race([
        tool.execute(input, {
          cwd: this.#cwd,
          signal: controller.signal,
          checkpoint: this.#checkpoint,
          fileState: this.#fileState,
        }),
        aborted,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
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
