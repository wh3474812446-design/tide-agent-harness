import { readFile } from "node:fs/promises";
import type { JsonSchema, RiskLevel } from "../../types.js";
import type { Tool } from "../tool.js";
import { ToolRegistry } from "../tool.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type TemplateValue =
  | string
  | number
  | boolean
  | null
  | TemplateValue[]
  | { [key: string]: TemplateValue };

export interface ApiToolConfig {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, TemplateValue>;
  body?: TemplateValue;
  risk?: RiskLevel;
  concurrencySafe?: boolean;
  includeResponseHeaders?: boolean;
  maxResponseChars?: number;
}

export interface ApiToolsFile {
  tools: ApiToolConfig[];
}

export interface ApiToolOptions {
  env?: Record<string, string | undefined>;
}

const DEFAULT_MAX_RESPONSE_CHARS = 30000;
const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_PATTERN = /^\{\{\s*([^}]+?)\s*\}\}$/;
const VALID_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const VALID_RISKS = new Set<RiskLevel>(["read", "write", "execute", "network"]);

export async function loadApiToolsFile(filePath: string): Promise<ApiToolsFile> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  assertApiToolsFile(parsed);
  return parsed;
}

export async function registerApiToolsFromFile(
  registry: ToolRegistry,
  filePath: string,
  options: ApiToolOptions = {},
): Promise<number> {
  const file = await loadApiToolsFile(filePath);
  for (const config of file.tools) {
    registry.register(createApiTool(config, options));
  }
  return file.tools.length;
}

export function createApiTool(config: ApiToolConfig, options: ApiToolOptions = {}): Tool {
  assertApiToolConfig(config);
  const method = config.method ?? "GET";
  const env = options.env ?? process.env;
  const maxResponseChars = config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;

  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    risk: config.risk ?? "network",
    concurrencySafe: config.concurrencySafe ?? (method === "GET" || method === "HEAD"),
    async execute(input, context) {
      const requestUrl = buildUrl(config.url, config.query, input, env);
      const headers = buildHeaders(config.headers, input, env);
      const init: RequestInit = { method, headers, signal: context.signal };
      if (config.body !== undefined && method !== "GET" && method !== "HEAD") {
        const renderedBody = renderTemplateValue(config.body, input, env);
        if (typeof renderedBody === "string") {
          init.body = renderedBody;
          ensureHeader(headers, "content-type", "text/plain; charset=utf-8");
        } else {
          init.body = JSON.stringify(renderedBody);
          ensureHeader(headers, "content-type", "application/json");
        }
      }

      const response = await fetch(requestUrl, init);
      const responseText = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const parsedBody = parseResponseBody(responseText, contentType);
      const output: Record<string, unknown> = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType,
        body: parsedBody,
      };
      if (config.includeResponseHeaders) {
        output.headers = Object.fromEntries(response.headers.entries());
      }

      const serialized = JSON.stringify(output, null, 2);
      if (response.ok) return truncate(serialized, maxResponseChars);
      throw new Error(truncate(serialized, maxResponseChars));
    },
  };
}

function buildUrl(
  urlTemplate: string,
  query: Record<string, TemplateValue> | undefined,
  input: unknown,
  env: Record<string, string | undefined>,
): string {
  const renderedUrl = renderTemplateValue(urlTemplate, input, env);
  if (typeof renderedUrl !== "string") throw new Error("Rendered API URL must be a string.");
  const url = new URL(renderedUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    const rendered = renderTemplateValue(value, input, env);
    if (rendered === null || rendered === undefined) continue;
    if (Array.isArray(rendered)) {
      for (const item of rendered) {
        if (item !== null && item !== undefined) url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(rendered));
    }
  }
  return url.toString();
}

function buildHeaders(
  headerTemplates: Record<string, string> | undefined,
  input: unknown,
  env: Record<string, string | undefined>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(headerTemplates ?? {})) {
    const rendered = renderTemplateValue(value, input, env);
    if (rendered === null || rendered === undefined) continue;
    headers.set(key, String(rendered));
  }
  return headers;
}

function ensureHeader(headers: Headers, key: string, value: string): void {
  if (!headers.has(key)) headers.set(key, value);
}

function renderTemplateValue(
  value: TemplateValue,
  input: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, input, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplateValue(item, input, env)]),
    );
  }
  if (typeof value !== "string") return value;

  const exact = value.match(EXACT_TEMPLATE_PATTERN);
  if (exact?.[1]) return resolveTemplateExpression(exact[1], input, env);

  return value.replace(TEMPLATE_PATTERN, (_, expression: string) => {
    const resolved = resolveTemplateExpression(expression, input, env);
    if (resolved === null || resolved === undefined) return "";
    if (typeof resolved === "object") return JSON.stringify(resolved);
    return String(resolved);
  });
}

function resolveTemplateExpression(
  expression: string,
  input: unknown,
  env: Record<string, string | undefined>,
): unknown {
  const trimmed = expression.trim();
  if (trimmed === "input") return input;
  if (trimmed.startsWith("input.")) return readPath(input, trimmed.slice("input.".length), "input");
  if (trimmed.startsWith("env.")) {
    const key = trimmed.slice("env.".length);
    const value = env[key];
    if (value === undefined) throw new Error(`Missing environment variable: ${key}`);
    return value;
  }
  throw new Error(`Unsupported template expression: ${trimmed}`);
}

function readPath(source: unknown, path: string, label: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (!segment) throw new Error(`Invalid ${label} template path: ${path}`);
    if (current === null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`Missing ${label} template value: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseResponseBody(text: string, contentType: string): unknown {
  if (!text) return "";
  if (!contentType.toLowerCase().includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const half = Math.floor(maxChars / 2);
  return `${output.slice(0, half)}\n\n[... ${output.length - maxChars} characters omitted ...]\n\n${output.slice(-half)}`;
}

function assertApiToolsFile(value: unknown): asserts value is ApiToolsFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as ApiToolsFile).tools)) {
    throw new Error("API tools file must be an object with a tools array.");
  }
  for (const tool of (value as ApiToolsFile).tools) assertApiToolConfig(tool);
}

function assertApiToolConfig(value: unknown): asserts value is ApiToolConfig {
  if (!value || typeof value !== "object") throw new Error("API tool config must be an object.");
  const tool = value as ApiToolConfig;
  if (!tool.name || typeof tool.name !== "string") throw new Error("API tool requires a string name.");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tool.name)) {
    throw new Error(`Invalid API tool name: ${tool.name}`);
  }
  if (!tool.description || typeof tool.description !== "string") {
    throw new Error(`API tool ${tool.name} requires a string description.`);
  }
  if (!tool.url || typeof tool.url !== "string") {
    throw new Error(`API tool ${tool.name} requires a string url.`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error(`API tool ${tool.name} requires an object inputSchema.`);
  }
  if (tool.method !== undefined && !VALID_METHODS.has(tool.method)) {
    throw new Error(`API tool ${tool.name} has unsupported method: ${tool.method}`);
  }
  if (tool.risk !== undefined && !VALID_RISKS.has(tool.risk)) {
    throw new Error(`API tool ${tool.name} has unsupported risk: ${tool.risk}`);
  }
  if (tool.maxResponseChars !== undefined && tool.maxResponseChars < 1) {
    throw new Error(`API tool ${tool.name} maxResponseChars must be positive.`);
  }
}
