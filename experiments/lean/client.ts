import type { FetchLike } from "../../src/agents/structured.js";

// One chat-completions client for the lean reviewer. It talks to the credential proxy (the real key never reaches this
// process). Unlike the OpenCode path, what the provider said is kept: HTTP status plus the provider's error `type` and
// `code` words. The message text and the response body are dropped, because they can echo request content; the only
// exception is the opt-in debug transcript hook (onTranscript), which is off unless a debugging run asks for it.
// Only HTTP 429 is retried, a bounded number of times, waiting for Retry-After when the provider sends one.

const WORD = /^[a-z_]{1,40}$/;
const DEFAULT_WAIT_MS = 2_000;
const MAX_WAIT_MS = 60_000;

/** What kind of tool-call rejection Groq reported, as fixed words. Nothing from the provider body is kept except these. */
type NameShape = "valid_name" | "garbled_read" | "garbled_grep" | "garbled_glob" | "garbled_list" | "garbled_other" | "other_plain_name";

export interface ToolUseFailure {
  readonly kind: "unknown_tool" | "bad_arguments" | "unspecified";
  /** For unknown_tool: the shape of the rejected tool name, never the name itself. */
  readonly nameShape?: NameShape;
}

export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string, readonly errorType: string, readonly retries: number, readonly toolUse?: ToolUseFailure) {
    super(`provider_${status}_${code}`);
    this.name = "ProviderError";
  }
}

/** The token rate-limit headers of a reply, as numbers. A field is missing when the header was absent or not plain. */
export interface RateInfo {
  readonly remainingTokens?: number;
  readonly limitTokens?: number;
  readonly resetTokensMs?: number;
}

export interface ChatResult {
  readonly json: unknown;
  /** 429 retries this call needed. */
  readonly retries: number;
  /** Always set by createChat (possibly empty); optional so scripted test models can leave it out. */
  readonly rate?: RateInfo;
}

/**
 * One request and the provider's raw answer, for the opt-in private debug transcript. It holds source code and model
 * output (including Groq's failed_generation), so it must never go into the trace, the result or a public artifact.
 */
export interface TranscriptEntry {
  /** 0 for the first attempt of a call, then 1, 2, ... for its 429 retries. */
  readonly attempt: number;
  readonly status: number;
  readonly request: object;
  readonly response: string;
}

const MAX_TRANSCRIPT_RESPONSE = 100_000;
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
  /** Debug only: receives every attempt with its raw response. Leave unset for normal runs. */
  readonly onTranscript?: (entry: TranscriptEntry) => void;
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
      const text = await response.text().catch(() => "");
      options.onTranscript?.(Object.freeze({ attempt, status: response.status, request: body, response: capped(text) }));
      if (response.ok) return Object.freeze({ json: parse(text, response.status, attempt), retries: attempt, rate: readRate(response.headers) });
      const facts = errorFacts(text);
      if (response.status !== 429 || attempt >= perCall || used >= total) throw new ProviderError(response.status, facts.code, facts.type, attempt, facts.toolUse);
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

function errorFacts(text: string): { code: string; type: string; toolUse?: ToolUseFailure } {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error ?? {};
    const word = (v: unknown): string => (typeof v === "string" && WORD.test(v) ? v : "unknown");
    const code = word(error.code);
    // failed_generation (the model's raw output) is never read. Only the fixed shape of the message is classified.
    return { code, type: word(error.type), ...(code === "tool_use_failed" ? { toolUse: classifyToolUse(error.message) } : {}) };
  } catch {
    return { code: "unknown", type: "unknown" };
  }
}

const REJECTED_TOOL = /attempted to call tool '([^']{0,80})' which was not in request\.tools/;
const OFFERED_TOOL = /^cra_(read|grep|glob|list)$/;

function classifyToolUse(message: unknown): ToolUseFailure {
  const text = typeof message === "string" ? message.slice(0, 1_000) : "";
  const rejected = REJECTED_TOOL.exec(text)?.[1];
  if (rejected !== undefined) {
    if (OFFERED_TOOL.test(rejected)) return { kind: "unknown_tool", nameShape: "valid_name" };
    const near = /^cra_(read|grep|glob|list)/.exec(rejected);
    if (near) return { kind: "unknown_tool", nameShape: `garbled_${near[1]}` as NameShape };
    return { kind: "unknown_tool", nameShape: /^[a-z_]{1,40}$/.test(rejected) ? "other_plain_name" : "garbled_other" };
  }
  return /parameters for tool|did not match schema|validation failed/i.test(text) ? { kind: "bad_arguments" } : { kind: "unspecified" };
}

const COUNT = /^\d{1,9}$/;
const DURATION = /^(?:\d{1,6}(?:\.\d{1,6})?(?:ms|h|m|s))+$/;
const DURATION_PART = /(\d{1,6}(?:\.\d{1,6})?)(ms|h|m|s)/g;
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** Groq's duration format ("7.66s", "2m59.56s", "120ms") in milliseconds, or undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  if (!DURATION.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(DURATION_PART)) total += Number(amount) * (UNIT_MS[unit ?? ""] ?? 0);
  return Math.round(total);
}

function readRate(headers: { get(name: string): string | null }): RateInfo {
  const count = (name: string): number | undefined => {
    const raw = headers.get(name)?.trim() ?? "";
    return COUNT.test(raw) ? Number(raw) : undefined;
  };
  const remainingTokens = count("x-ratelimit-remaining-tokens");
  const limitTokens = count("x-ratelimit-limit-tokens");
  const resetTokensMs = parseDuration(headers.get("x-ratelimit-reset-tokens")?.trim() ?? "");
  return Object.freeze({
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(limitTokens !== undefined ? { limitTokens } : {}),
    ...(resetTokensMs !== undefined ? { resetTokensMs } : {}),
  });
}

function capped(text: string): string {
  return text.length <= MAX_TRANSCRIPT_RESPONSE ? text : `${text.slice(0, MAX_TRANSCRIPT_RESPONSE)}[truncated ${text.length - MAX_TRANSCRIPT_RESPONSE} chars]`;
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
