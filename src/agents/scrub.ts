import { TRANSPORT_MARKER, classifyError, type ErrorKind } from "../resilience/errors.js";

const STATUS_BY_KIND: Readonly<Partial<Record<ErrorKind, number>>> = {
  rate_limit: 429,
  server: 503,
  auth: 401,
  context_overflow: 413,
};

// OpenCode reports its own errors as objects with a fixed `name`. Only names from this list are kept (never `data`).
const SDK_ERROR_NAMES: ReadonlySet<string> = new Set(["APIError", "MessageAbortedError", "MessageOutputLengthError", "ProviderAuthError", "UnknownError", "ContextOverflowError", "RetryBudgetExceeded", "CompactionObserved", "SessionNeverStarted", "TransportTimeoutError"]);

/** Token usage an attempt is known to have consumed. `complete: false` means a lower bound (work was cut short). */
export interface KnownUsage {
  readonly input: number;
  readonly output: number;
  readonly complete: boolean;
}

/** Reads usage off an error, accepting only plain non-negative numbers. */
export function usageOf(err: unknown): KnownUsage | undefined {
  const raw = typeof err === "object" && err !== null ? (err as { usage?: unknown }).usage : undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { input, output, complete } = raw as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return ok(input) && ok(output) ? { input, output, complete: complete === true } : undefined;
}

/**
 * Replaces a provider or SDK error with one that is safe to log, store and show. Only the kind survives, as a fixed
 * message, the HTTP status the retry logic needs, and the server's retry delay. The original message, body, headers
 * and stack are dropped on purpose: they can hold request text, keys or repository content.
 */
export function scrubProviderError(err: unknown): Error {
  const classified = classifyError(err);
  const name = classified.kind === "abort" ? abortName(err) : "ProviderError";
  const scrubbed = new Error(`provider_${classified.kind}`);
  const status = STATUS_BY_KIND[classified.kind];
  const sdkName = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  const usage = usageOf(err);
  return Object.assign(scrubbed, {
    name,
    ...(classified.kind === "transport" ? { code: TRANSPORT_MARKER } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof sdkName === "string" && SDK_ERROR_NAMES.has(sdkName) ? { sdkName } : {}),
    ...(status === undefined ? {} : { status }),
    ...(classified.retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(classified.retryAfterMs) } }),
  });
}

function abortName(err: unknown): "TimeoutError" | "AbortError" {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError" ? "TimeoutError" : "AbortError";
}
