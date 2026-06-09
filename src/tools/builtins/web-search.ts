import type { Tool } from "../tool.js";

interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web and return result titles, URLs, and snippets. Use to find current information " +
    "or pages to read with web_fetch. Backed by DuckDuckGo (no API key needed).",
  risk: "network",
  concurrencySafe: true,
  maxResultChars: 12000,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Search query." },
      maxResults: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 6)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const { query, maxResults = 6 } = input as WebSearchInput;
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(endpoint, {
      signal: context.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; Tide/1.0)" },
    });
    if (!response.ok) throw new Error(`搜索失败 ${response.status} ${response.statusText}`);
    const html = await response.text();

    const results = parseDuckDuckGo(html).slice(0, maxResults);
    if (results.length === 0) return `没有搜到 "${query}" 的结果（或被搜索源限流，可稍后重试）。`;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 解析 DuckDuckGo HTML 结果页：抓 result__a 链接 + result__snippet 摘要。 */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1] ?? ""));

  let lm: RegExpExecArray | null;
  let idx = 0;
  while ((lm = linkRe.exec(html))) {
    const url = decodeDuckUrl(lm[1] ?? "");
    const title = stripTags(lm[2] ?? "");
    if (!url || !title) continue;
    results.push({ title, url, snippet: snippets[idx] ?? "" });
    idx += 1;
  }
  return results;
}

/** DuckDuckGo 的跳转链接形如 //duckduckgo.com/l/?uddg=<编码真实URL>，解出真实地址。 */
function decodeDuckUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
