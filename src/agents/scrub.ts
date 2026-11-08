import { classifyError, type ErrorKind } from "../resilience/errors.js";

const STATUS_BY_KIND: Readonly<Partial<Record<ErrorKind, number>>> = {
  rate_limit: 429,
  server: 503,
  auth: 401,
  context_overflow: 413,
};

// OpenCode reports its own errors as objects with a fixed `name`. Only names from this list are kept (never `data`).
const SDK_ERROR_NAMES: ReadonlySet<string> = new Set(["APIError", "MessageAbortedError", "MessageOutputLengthError", "ProviderAuthError", "UnknownError"]);

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
  return Object.assign(scrubbed, {
    name,
    ...(typeof sdkName === "string" && SDK_ERROR_NAMES.has(sdkName) ? { sdkName } : {}),
    ...(status === undefined ? {} : { status }),
    ...(classified.retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(classified.retryAfterMs) } }),
  });
}

function abortName(err: unknown): "TimeoutError" | "AbortError" {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError" ? "TimeoutError" : "AbortError";
}
