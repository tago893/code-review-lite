import type { FetchLike } from "../../src/agents/structured.js";

// One chat-completions client for the lean reviewer. It talks to the credential proxy (the real key never reaches this
// process). Unlike the OpenCode path, what the provider said is kept: HTTP status plus the provider's error `type` and
// `code` words. The message text and the response body are dropped, because they can echo request content.
// Only HTTP 429 is retried, a bounded number of times, waiting for Retry-After when the provider sends one.

const WORD = /^[a-z_]{1,40}$/;
const DEFAULT_WAIT_MS = 2_000;
const MAX_WAIT_MS = 60_000;

export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string, readonly errorType: string, readonly retries: number) {
    super(`provider_${status}_${code}`);
    this.name = "ProviderError";
  }
}

export interface ChatResult {
  readonly json: unknown;
  /** 429 retries this call needed. */
  readonly retries: number;
}
export type ChatFn = (body: object) => Promise<ChatResult>;

export interface ClientOptions {
  readonly baseUrl: string;
  /** The run deadline. Aborting it cancels an in-flight request and any wait between retries. */
  readonly signal?: AbortSignal;
  readonly fetchFn?: FetchLike;
  readonly maxRetriesPerCall?: number;
  readonly maxRetriesTotal?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onRetry?: (info: { readonly retryNo: number; readonly waitMs: number }) => void;
}

export function createChat(options: ClientOptions): ChatFn {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
  const sleep = options.sleep ?? abortableSleep;
  const perCall = options.maxRetriesPerCall ?? 3;
  const total = options.maxRetriesTotal ?? 8;
  let used = 0;

  return async (body) => {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const response = await send(fetchFn, url, payload, options.signal, attempt);
      if (response.ok) return Object.freeze({ json: parse(await response.text(), response.status, attempt), retries: attempt });
      const facts = errorFacts(await response.text().catch(() => ""));
      if (response.status !== 429 || attempt >= perCall || used >= total) throw new ProviderError(response.status, facts.code, facts.type, attempt);
      const waitMs = Math.min(retryAfterMs(response.headers) ?? DEFAULT_WAIT_MS * 2 ** attempt, MAX_WAIT_MS);
      used += 1;
      options.onRetry?.({ retryNo: used, waitMs });
      try {
        await sleep(waitMs, options.signal);
      } catch {
        throw new ProviderError(0, "deadline", "deadline", attempt);
      }
    }
  };
}

async function send(fetchFn: FetchLike, url: string, body: string, signal: AbortSignal | undefined, retries: number): ReturnType<FetchLike> {
  try {
    const init = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer proxy-placeholder" }, body };
    return await fetchFn(url, signal ? { ...init, signal } : init);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (signal?.aborted || name === "AbortError" || name === "TimeoutError") throw new ProviderError(0, "deadline", "deadline", retries);
    throw new ProviderError(0, "network_error", "network", retries);
  }
}

function parse(text: string, status: number, retries: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(status, "malformed_response", "malformed_response", retries);
  }
}

function errorFacts(text: string): { code: string; type: string } {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown } }).error ?? {};
    const word = (v: unknown): string => (typeof v === "string" && WORD.test(v) ? v : "unknown");
    return { code: word(error.code), type: word(error.type) };
  } catch {
    return { code: "unknown", type: "unknown" };
  }
}

function retryAfterMs(headers: { get(name: string): string | null }): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0 && headers.get("retry-after-ms") !== null) return ms;
  const raw = headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
