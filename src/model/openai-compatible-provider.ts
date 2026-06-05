import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  TextBlock,
  ToolCallBlock,
} from "../types.js";
import type { ModelProvider } from "./provider.js";

interface OpenAICompatibleProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(systemPrompt: string, messages: Message[]): OpenAIMessage[] {
  const converted: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    converted.push(...toOpenAIConversationMessages(message));
  }
  return converted;
}

function toOpenAIConversationMessages(message: Message): OpenAIMessage[] {
  if (message.role === "assistant") {
    const text = textFromBlocks(message.content);
    const toolCalls = message.content
      .filter((block): block is ToolCallBlock => block.type === "tool_call")
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));
    return [
      {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  const converted: OpenAIMessage[] = [];
  const userText = textFromBlocks(message.content);
  if (userText) converted.push({ role: "user", content: userText });
  for (const block of message.content) {
    if (block.type === "tool_result") {
      converted.push({
        role: "tool",
        tool_call_id: block.toolCallId,
        content: block.output,
      });
    }
  }
  return converted;
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly #options: Required<OpenAICompatibleProviderOptions>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.#options = {
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 4096,
      ...options,
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${trimTrailingSlash(this.#options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.#options.model,
        messages: toOpenAIMessages(request.systemPrompt, request.messages),
        max_tokens: this.#options.maxTokens,
        stream: false,
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
              tool_choice: "auto",
            }
          : {}),
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = body.choices?.[0];
    const message = choice?.message;
    const content: Array<TextBlock | ToolCallBlock> = [];
    if (typeof message?.content === "string" && message.content.length > 0) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message?.tool_calls ?? []) {
      if (call.type !== "function" || !call.id || !call.function?.name) continue;
      content.push({
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments ?? "{}"),
      });
    }

    const reasoning =
      typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0
        ? message.reasoning_content
        : undefined;

    return {
      content,
      stopReason: choice?.finish_reason,
      reasoning,
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
      },
    };
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
