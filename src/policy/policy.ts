import type { RiskLevel } from "../types.js";
import type { Tool } from "../tools/tool.js";

export interface ApprovalRequest {
  tool: Tool;
  input: unknown;
  /** 可选：给用户看的预览（如编辑 diff），由执行器提前算好传入。 */
  preview?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class RiskPolicy {
  readonly #allow = new Set<RiskLevel>();
  readonly #deny = new Set<RiskLevel>();
  readonly #approval?: ApprovalHandler;
  #planMode = false;

  constructor(options?: {
    allow?: RiskLevel[];
    deny?: RiskLevel[];
    approval?: ApprovalHandler;
  }) {
    for (const risk of options?.allow ?? ["read"]) this.#allow.add(risk);
    for (const risk of options?.deny ?? []) this.#deny.add(risk);
    this.#approval = options?.approval;
  }

  /** 计划模式：开启后只允许 read，写/执行/联网一律拦截（对照 Claude Code 的 plan mode）。 */
  setPlanMode(on: boolean): void {
    this.#planMode = on;
  }

  get planMode(): boolean {
    return this.#planMode;
  }

  async decide(tool: Tool, input: unknown, preview?: string): Promise<PolicyDecision> {
    if (this.#planMode && tool.risk !== "read") {
      return { allowed: false, reason: `计划模式：暂不执行 ${tool.risk} 操作，请先给出计划等用户确认。` };
    }
    if (this.#deny.has(tool.risk)) {
      return { allowed: false, reason: `${tool.risk} operations are denied by policy.` };
    }
    if (this.#allow.has(tool.risk)) {
      return { allowed: true, reason: `${tool.risk} operations are allowed by policy.` };
    }
    if (!this.#approval) {
      return { allowed: false, reason: "Approval is required, but no approver is available." };
    }
    const approved = await this.#approval({ tool, input, preview });
    return {
      allowed: approved,
      reason: approved ? "Approved by user." : "Denied by user.",
    };
  }
}

