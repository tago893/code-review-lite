import { classifyError, type ErrorKind } from "../resilience/errors.js";

const STATUS_BY_KIND: Readonly<Partial<Record<ErrorKind, number>>> = {
  rate_limit: 429,
  server: 503,
  auth: 401,
  context_overflow: 413,
};

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
  return Object.assign(scrubbed, {
    name,
    ...(status === undefined ? {} : { status }),
    ...(classified.retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(classified.retryAfterMs) } }),
  });
}

function abortName(err: unknown): "TimeoutError" | "AbortError" {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError" ? "TimeoutError" : "AbortError";
}
