/**
 * 模型 API 请求的重试封装（对照 Claude Code 的 429/5xx 退避重试）。
 * 长任务跑一小时碰上一次瞬时 429 / 网络抖动不应让整个 run 作废——
 * 在 provider 这一层兜住：指数退避 + 抖动，尊重 Retry-After，可中止。
 *
 * 只重试「重试有意义」的失败：429 / 408 / 5xx / 网络层异常。
 * 4xx 业务错误（400 参数错、401 鉴权、413 过长……）立即抛出，交上层处理。
 * 流式请求同样适用：重试只发生在拿到响应头之前，正文中途断开不重发（避免重复输出）。
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface RetryConfig {
  /** 最大重试次数（不含首次）。默认 env HARNESS_API_RETRIES 或 3。 */
  retries?: number;
  /** 退避基数毫秒，第 n 次重试等待 base*2^n（±25% 抖动）。默认 env HARNESS_API_RETRY_BASE_MS 或 1000。 */
  baseDelayMs?: number;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: RetryConfig = {},
): Promise<Response> {
  const retries = config.retries ?? envInt("HARNESS_API_RETRIES", 3);
  const baseDelay = config.baseDelayMs ?? envInt("HARNESS_API_RETRY_BASE_MS", 1000);
  const signal = init.signal instanceof AbortSignal ? init.signal : undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay = retryDelayMs(lastError, attempt, baseDelay);
      await sleep(delay, signal);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // 用户主动中止：不算可重试失败，原样抛出。
      if (signal?.aborted) throw error;
      lastError = error; // 网络层异常（DNS / 连接重置 / 超时）→ 重试
      continue;
    }

    if (!RETRYABLE_STATUS.has(response.status)) return response; // 成功或不可重试的业务错误
    lastError = new RetryableHttpError(response.status, response.headers.get("retry-after"));
    // 消费掉响应体，避免连接泄漏。
    await response.text().catch(() => "");
  }

  if (lastError instanceof RetryableHttpError) {
    throw new Error(`API 在重试 ${retries} 次后仍失败（HTTP ${lastError.status}）。`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** 计算第 attempt 次重试前的等待：优先 Retry-After（封顶 60s），否则指数退避+抖动（封顶 30s）。 */
function retryDelayMs(lastError: unknown, attempt: number, baseDelay: number): number {
  if (lastError instanceof RetryableHttpError && lastError.retryAfter) {
    const seconds = Number(lastError.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  const exponential = baseDelay * 2 ** (attempt - 1);
  const jitter = 0.75 + Math.random() * 0.5; // ±25%
  return Math.min(exponential * jitter, 30_000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
