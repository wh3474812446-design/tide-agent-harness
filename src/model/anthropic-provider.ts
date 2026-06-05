import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  TextBlock,
  ToolCallBlock,
} from "../types.js";
import type { ModelProvider } from "./provider.js";

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  baseUrl?: string;
}

function toAnthropicBlock(block: ContentBlock): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_call") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  return {
    type: "tool_result",
    tool_use_id: block.toolCallId,
    content: block.output,
    is_error: block.isError ?? false,
  };
}

function toAnthropicMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly #options: Required<AnthropicProviderOptions>;

  constructor(options: AnthropicProviderOptions) {
    this.#options = {
      maxTokens: 4096,
      baseUrl: "https://api.anthropic.com/v1/messages",
      ...options,
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(this.#options.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.#options.model,
        max_tokens: this.#options.maxTokens,
        system: request.systemPrompt,
        messages: request.messages.map(toAnthropicMessage),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      content?: Array<Record<string, unknown>>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const content: Array<TextBlock | ToolCallBlock> = [];
    for (const block of body.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
        continue;
      }
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        const toolCall: ToolCallBlock = {
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: block.input,
        };
        content.push(toolCall);
      }
    }

    return {
      content,
      stopReason: body.stop_reason,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
      },
    };
  }
}
