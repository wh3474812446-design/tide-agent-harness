export type JsonSchema = Record<string, unknown>;

export type RiskLevel = "read" | "write" | "execute" | "network";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ModelToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: Array<TextBlock | ToolCallBlock>;
  stopReason?: string;
  reasoning?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AgentResult {
  sessionId: string;
  finalText: string;
  reasoning?: string;
  turns: number;
  toolCalls: number;
  messages: Message[];
}

