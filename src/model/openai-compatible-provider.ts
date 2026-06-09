import type {
  ContentBlock,
  Message,
  ModelRequest,
  ModelResponse,
  TextBlock,
  ToolCallBlock,
} from "../types.js";
import type { ModelProvider, StreamCallbacks } from "./provider.js";

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

  get model(): string {
    return this.#options.model;
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

  /** 流式实现：解析 SSE，边收边回调，结束后拼出完整 ModelResponse（含工具调用与 usage）。 */
  async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelResponse> {
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
        stream: true,
        stream_options: { include_usage: true },
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

    if (!response.ok || !response.body) {
      throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);
    }

    let text = "";
    let reasoning = "";
    let stopReason: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    // 工具调用按 index 累积（参数是分片到达的 JSON 字符串）。
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          callbacks.onText?.(delta.content);
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          callbacks.onReasoning?.(delta.reasoning_content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = toolAcc.get(idx) ?? { args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(idx, acc);
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
    }

    const content: Array<TextBlock | ToolCallBlock> = [];
    if (text) content.push({ type: "text", text });
    for (const acc of toolAcc.values()) {
      if (!acc.id || !acc.name) continue;
      content.push({ type: "tool_call", id: acc.id, name: acc.name, input: parseToolArguments(acc.args || "{}") });
    }

    return {
      content,
      stopReason,
      reasoning: reasoning || undefined,
      usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens },
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
