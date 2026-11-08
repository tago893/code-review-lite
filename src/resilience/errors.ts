/**
 * "server" is an HTTP 5xx from the provider. "transport" is a failure of one of our own HTTP calls (connection reset,
 * a client-side timeout, "fetch failed"): the provider may never have been reached, and the two must not be confused.
 */
export type ErrorKind = "rate_limit" | "server" | "transport" | "auth" | "context_overflow" | "step_limit" | "abort" | "unknown";

export interface ErrorClass {
  readonly retryable: boolean;
  readonly kind: ErrorKind;
  /** Server-provided wait before retrying, when the error carried one. Only present on retryable errors. */
  readonly retryAfterMs?: number;
}

const CONTEXT_OVERFLOW_MESSAGE =
  /context[_ ]length|context window|maximum context|reduce the length|too many tokens|prompt is too long|request too large/i;
/** Set on a scrubbed transport error so it is still recognised (and retried) after its original fields are dropped. */
export const TRANSPORT_MARKER = "CRA_TRANSPORT";

/** Set on a scrubbed step-limit error so it is still recognised after its original fields are dropped. */
export const STEP_LIMIT_MARKER = "CRA_STEP_LIMIT";

const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  TRANSPORT_MARKER,
]);

/**
 * Decides whether an error is worth retrying and what kind it is. It reads status, code, name and (for pattern
 * matching only) the message; the result never contains any of them, so it is safe to log. Never throws.
 */
export function classifyError(err: unknown): ErrorClass {
  try {
    return classify(err);
  } catch {
    return Object.freeze({ retryable: false, kind: "unknown" as const });
  }
}

function classify(err: unknown): ErrorClass {
  if (err === null || typeof err !== "object") return result("unknown", false);
  const name = str(get(err, "name"));
  const code = str(get(err, "code"));
  const message = str(get(err, "message"));
  const status = statusOf(err);

  if (name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR") return result("abort", false);
  if (name === "StepLimitExceeded" || code === STEP_LIMIT_MARKER) return result("step_limit", false);
  if (name === "ContextOverflowError" || code === "context_length_exceeded" || status === 413 || CONTEXT_OVERFLOW_MESSAGE.test(message)) return result("context_overflow", false);
  if (status === 401 || status === 403) return result("auth", false);
  if (status === 429) return result("rate_limit", true, retryAfterMs(err, message));
  if (status !== undefined && status >= 500 && status <= 599) return result("server", true, retryAfterMs(err, message));
  if (NETWORK_CODES.has(code) || NETWORK_CODES.has(str(get(get(err, "cause"), "code"))) || name === "TransportTimeoutError" || /fetch failed/i.test(message)) {
    return result("transport", true);
  }
  return result("unknown", false);
}

function result(kind: ErrorKind, retryable: boolean, retryAfter?: number): ErrorClass {
  return Object.freeze(retryable && retryAfter !== undefined ? { retryable, kind, retryAfterMs: retryAfter } : { retryable, kind });
}

function get(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function statusOf(err: unknown): number | undefined {
  const candidates = [get(err, "status"), get(err, "statusCode"), get(get(err, "response"), "status"), get(get(err, "data"), "statusCode"), get(get(err, "cause"), "status")];
  const found = candidates.find((c): c is number => typeof c === "number" && Number.isInteger(c));
  return found;
}

// --- retry delay ---------------------------------------------------------------------------------------------

function retryAfterMs(err: unknown, message: string): number | undefined {
  const headers = get(err, "headers") ?? get(get(err, "response"), "headers");
  const ms = headerValue(headers, "retry-after-ms");
  if (ms !== undefined && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const seconds = headerValue(headers, "retry-after");
  if (seconds !== undefined && /^\d+(\.\d+)?$/.test(seconds)) return Math.round(Number(seconds) * 1000);
  return delayFromMessage(message);
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value: unknown = (getter as (n: string) => unknown).call(headers, name);
    return typeof value === "string" ? value.trim() : undefined;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : undefined;
}

/** Parses "try again in 1m30.5s", "6.5s" or "250ms" as written in provider rate-limit messages. */
function delayFromMessage(message: string): number | undefined {
  const match = /try again in\s+((?:\d+(?:\.\d+)?(?:ms|s|m|h))+)/i.exec(message);
  if (!match) return undefined;
  const unitMs: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const part of (match[1] ?? "").matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gi)) {
    total += Number(part[1]) * (unitMs[(part[2] ?? "").toLowerCase()] ?? 0);
  }
  return Math.round(total);
}
