import type { ModelRequest, ModelResponse } from "../types.js";

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

