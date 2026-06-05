import type { RiskLevel } from "../types.js";
import type { Tool } from "../tools/tool.js";

export interface ApprovalRequest {
  tool: Tool;
  input: unknown;
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

  constructor(options?: {
    allow?: RiskLevel[];
    deny?: RiskLevel[];
    approval?: ApprovalHandler;
  }) {
    for (const risk of options?.allow ?? ["read"]) this.#allow.add(risk);
    for (const risk of options?.deny ?? []) this.#deny.add(risk);
    this.#approval = options?.approval;
  }

  async decide(tool: Tool, input: unknown): Promise<PolicyDecision> {
    if (this.#deny.has(tool.risk)) {
      return { allowed: false, reason: `${tool.risk} operations are denied by policy.` };
    }
    if (this.#allow.has(tool.risk)) {
      return { allowed: true, reason: `${tool.risk} operations are allowed by policy.` };
    }
    if (!this.#approval) {
      return { allowed: false, reason: "Approval is required, but no approver is available." };
    }
    const approved = await this.#approval({ tool, input });
    return {
      allowed: approved,
      reason: approved ? "Approved by user." : "Denied by user.",
    };
  }
}

