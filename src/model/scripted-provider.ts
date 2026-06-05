import type { ModelRequest, ModelResponse } from "../types.js";
import type { ModelProvider } from "./provider.js";

export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.#responses.shift();
    if (!response) throw new Error("ScriptedProvider has no response left.");
    return structuredClone(response);
  }
}

