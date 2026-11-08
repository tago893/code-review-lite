import { describe, expect, it } from "vitest";
import { classifyError } from "../../src/resilience/errors.js";

const http = (status: number, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

describe("classifyError", () => {
  it.each([
    [429, "rate_limit"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [504, "server"],
  ])("treats HTTP %i as retryable (%s)", (status, kind) => {
    expect(classifyError(http(status))).toMatchObject({ retryable: true, kind });
  });

  it.each([401, 403])("treats HTTP %i as a non-retryable auth failure", (status) => {
    expect(classifyError(http(status))).toEqual({ retryable: false, kind: "auth" });
  });

  it("treats context overflow as non-retryable, by message or by status 413", () => {
    expect(classifyError(http(400, { message: "This model's maximum context length is 8192 tokens" }))).toEqual({ retryable: false, kind: "context_overflow" });
    expect(classifyError(new Error("Please reduce the length of the messages or completion"))).toEqual({ retryable: false, kind: "context_overflow" });
    expect(classifyError(http(413))).toEqual({ retryable: false, kind: "context_overflow" });
    expect(classifyError({ name: "StepLimitExceeded" })).toEqual({ retryable: false, kind: "step_limit" });
    expect(classifyError({ code: "context_length_exceeded" })).toEqual({ retryable: false, kind: "context_overflow" });
  });

  it("treats aborts and timeouts as non-retryable", () => {
    expect(classifyError(Object.assign(new Error("x"), { name: "AbortError" }))).toEqual({ retryable: false, kind: "abort" });
    expect(classifyError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toEqual({ retryable: false, kind: "abort" });
    expect(classifyError({ code: "ABORT_ERR" })).toEqual({ retryable: false, kind: "abort" });
  });

  it("reads the status from common error shapes", () => {
    expect(classifyError({ statusCode: 429 })).toMatchObject({ kind: "rate_limit" });
    expect(classifyError({ response: { status: 503 } })).toMatchObject({ kind: "server" });
    expect(classifyError({ data: { statusCode: 401 } })).toMatchObject({ kind: "auth" });
    expect(classifyError({ cause: { status: 429 } })).toMatchObject({ kind: "rate_limit" });
  });

  // A transport failure (our own HTTP call to the local OpenCode server failed) is not an upstream 5xx, and the
  // two must stay distinguishable in logs and in the retry record.
  it("classifies transient network failures as retryable transport errors, not server errors", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toMatchObject({ retryable: true, kind: "transport" });
    expect(classifyError(new TypeError("fetch failed"))).toMatchObject({ retryable: true, kind: "transport" });
  });

  it("classifies undici timeouts, including by cause, as transport", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }))).toMatchObject({ retryable: true, kind: "transport" });
    expect(classifyError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }))).toMatchObject({ retryable: true, kind: "transport" });
    expect(classifyError(Object.assign(new Error("request timed out"), { name: "TransportTimeoutError" }))).toMatchObject({ retryable: true, kind: "transport" });
  });

  it("keeps an HTTP 5xx as a server error even when a transport word appears in the message", () => {
    expect(classifyError(http(502, { message: "fetch failed upstream" }))).toMatchObject({ retryable: true, kind: "server" });
  });

  it("treats OpenCode's ContextOverflowError as non-retryable context overflow whatever its message says", () => {
    expect(classifyError({ name: "ContextOverflowError", data: { message: "Input exceeds the limit" } })).toEqual({ retryable: false, kind: "context_overflow" });
  });

  it("treats everything else as unknown and non-retryable, and never throws", () => {
    for (const value of [new Error("boom"), http(400), http(404), "string", 42, null, undefined, {}, [], Symbol("s")]) {
      expect(classifyError(value)).toEqual({ retryable: false, kind: "unknown" });
    }
    const hostile = { get status(): number { throw new Error("getter"); } };
    expect(classifyError(hostile)).toEqual({ retryable: false, kind: "unknown" });
  });

  it("returns the server-provided delay for rate limits: header seconds, plain headers, or the message", () => {
    expect(classifyError(http(429, { headers: new Headers({ "retry-after": "7" }) }))).toMatchObject({ retryAfterMs: 7000 });
    expect(classifyError(http(429, { headers: { "retry-after": "2.5" } }))).toMatchObject({ retryAfterMs: 2500 });
    expect(classifyError(http(429, { headers: { "retry-after-ms": "1200" } }))).toMatchObject({ retryAfterMs: 1200 });
    expect(classifyError(http(429, { message: "Rate limit reached. Please try again in 6.5s." }))).toMatchObject({ retryAfterMs: 6500 });
    expect(classifyError(http(429, { message: "Please try again in 1m30.5s" }))).toMatchObject({ retryAfterMs: 90500 });
    expect(classifyError(http(429, { message: "try again in 250ms" }))).toMatchObject({ retryAfterMs: 250 });
  });

  it("omits retryAfterMs when there is no usable delay, and for non-rate-limit errors", () => {
    expect(classifyError(http(429))).not.toHaveProperty("retryAfterMs");
    expect(classifyError(http(429, { headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }))).not.toHaveProperty("retryAfterMs");
    expect(classifyError(http(503, { headers: { "retry-after": "5" } }))).toMatchObject({ retryAfterMs: 5000 });
    expect(classifyError(http(401, { headers: { "retry-after": "5" } }))).not.toHaveProperty("retryAfterMs");
  });

  it("never copies the error message into its result", () => {
    const secret = "gsk_" + "a1B2c3D4e5F6g7H8";
    const result = classifyError(http(429, { message: `bad key ${secret}` }));
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
