import type { Tool } from "../tool.js";

interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page (or raw text/JSON) by URL and return its readable text content. " +
    "HTML is stripped to plain text. Use for reading docs, articles, or API responses.",
  risk: "network",
  concurrencySafe: true,
  maxResultChars: 30000,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
      maxChars: { type: "integer", minimum: 1, maximum: 100000, description: "Max characters to return (default 20000)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { url, maxChars = 20000 } = input as WebFetchInput;
    if (!/^https?:\/\//i.test(url)) throw new Error("只支持 http(s):// 开头的绝对 URL。");

    const response = await fetch(url, {
      signal: context.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; Tide/1.0)" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`抓取失败 ${response.status} ${response.statusText}`);

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const text = /html/i.test(contentType) ? htmlToText(raw) : raw.trim();

    const header = `URL: ${response.url}\n类型: ${contentType || "未知"}\n`;
    if (text.length <= maxChars) return `${header}\n${text}`;
    return `${header}\n${text.slice(0, maxChars)}\n\n[已截断 ${text.length - maxChars} 字符]`;
  },
};

/** 把 HTML 粗略转成可读纯文本：去掉脚本/样式、剥标签、还原常见实体、压空白。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
