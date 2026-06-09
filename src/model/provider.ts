import type { ModelRequest, ModelResponse } from "../types.js";

/** 流式增量回调：拿到一段文本/推理增量时调用。 */
export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface ModelProvider {
  /** 当前模型名（用于费用估算等）。 */
  readonly model?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  /** 可选流式接口：边收边回调，最终仍返回完整 ModelResponse。不实现则 agent 退回 complete()。 */
  stream?(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelResponse>;
}

