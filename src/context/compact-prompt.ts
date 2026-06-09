import type { Message } from "../types.js";

/**
 * 上下文摘要式压缩的提示词与工具函数。
 * 移植自 Claude Code 的 services/compact/prompt.ts（BASE_COMPACT_PROMPT + formatCompactSummary +
 * getCompactUserSummaryMessage），并适配 Tide 的扁平 Message 结构：
 * 长对话超过预算时，把较早的部分用模型压成一份结构化摘要，最近的消息原样保留。
 */

// 强约束「只输出文本、不要调工具」前导。摘要这一轮不带工具定义，
// 个别模型仍可能尝试工具调用浪费这唯一一轮，所以把约束放最前面。
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- You already have all the context you need in the conversation above.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off, to ensure there's no drift in task interpretation.

Structure your output as:

<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent: ...
2. Key Technical Concepts: ...
3. Files and Code Sections: ...
4. Errors and fixes: ...
5. Problem Solving: ...
6. All user messages: ...
7. Pending Tasks: ...
8. Current Work: ...
9. Optional Next Step: ...
</summary>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.";

/** 摘要这一轮喂给模型的 system prompt。 */
export function getCompactPrompt(): string {
  return NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + NO_TOOLS_TRAILER;
}

/**
 * 把较早的若干条消息扁平化成一段纯文本转录，作为摘要这一轮的唯一用户消息。
 * 扁平化（而非保留 tool_call/tool_result 结构）可避免「带 tool 块却不带 tools 定义」
 * 在部分 OpenAI 兼容服务上报错，跨供应商最稳。超长时按字符上限截断。
 */
export function messagesToTranscript(messages: Message[], maxChars = 120_000): string {
  const parts: string[] = [];
  for (const message of messages) {
    const role = message.role === "user" ? "User" : "Assistant";
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.trim()) parts.push(`${role}: ${block.text.trim()}`);
      } else if (block.type === "tool_call") {
        parts.push(`${role} [tool call: ${block.name}] ${safeJson(block.input)}`);
      } else if (block.type === "tool_result") {
        const flag = block.isError ? " (error)" : "";
        parts.push(`Tool result [${block.toolName}]${flag}: ${truncate(block.output, 4000)}`);
      }
    }
  }
  const transcript = parts.join("\n\n");
  if (transcript.length <= maxChars) return transcript;
  // 超长：保留开头（首个请求/意图）和结尾（最近进展），中间截断。
  const head = transcript.slice(0, Math.floor(maxChars * 0.4));
  const tail = transcript.slice(transcript.length - Math.floor(maxChars * 0.6));
  return `${head}\n\n…[transcript truncated]…\n\n${tail}`;
}

/**
 * 清洗模型返回的摘要：剥掉 <analysis> 草稿区，把 <summary> 标签换成可读标题。
 * 移植自 Claude Code 的 formatCompactSummary。
 */
export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match) {
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(match[1] ?? "").trim()}`);
  }
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

/**
 * 把摘要包成一条放在压缩后历史开头的用户消息文本。
 * 移植自 Claude Code 的 getCompactUserSummaryMessage：告知模型这是续接的会话、
 * 最近消息原样保留，直接从断点继续、不要复述。
 */
export function getCompactUserSummaryMessage(summary: string): string {
  const formatted = formatCompactSummary(summary);
  return `This session is being continued from an earlier conversation that ran out of context. The summary below covers the earlier portion of the conversation; the most recent messages after it are preserved verbatim.

${formatted}

Continue the work from where it left off based on the summary and the preserved recent messages. Do not recap the summary or ask the user to repeat anything — resume directly.`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function safeJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), 1000);
  } catch {
    return "[unserializable]";
  }
}
