import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsExhaustedError, runWithFallback } from "../../src/resilience/fallback.js";

const http = (status: number, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Runs a promise to completion while advancing fake time. */
async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const wrapped = promise.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
  await vi.runAllTimersAsync();
  return wrapped;
}

describe("runWithFallback", () => {
  it("returns the first success with no retries", async () => {
    const result = await settle(runWithFallback(["primary", "fallback"], async (m) => `ok:${m}`, { timeoutMs: 1000 }));
    expect(result).toEqual({ status: "fulfilled", value: { value: "ok:primary", modelUsed: "primary", retries: 0 } });
  });

  it("retries the primary once, then uses the fallback model and reports it", async () => {
    const calls: string[] = [];
    const attempt = async (m: string): Promise<string> => {
      calls.push(m);
      if (m === "primary") throw http(503);
      return "done";
    };
    const result = await settle(runWithFallback(["primary", "fallback"], attempt, { timeoutMs: 1000 }));
    expect(calls).toEqual(["primary", "primary", "fallback"]);
    expect(result).toEqual({ status: "fulfilled", value: { value: "done", modelUsed: "fallback", retries: 2 } });
  });

  it("succeeds on the retry of the same model", async () => {
    let n = 0;
    const result = await settle(runWithFallback(["primary", "fallback"], async () => { if (n++ === 0) throw http(429); return "ok"; }, { timeoutMs: 1000 }));
    expect(result).toMatchObject({ status: "fulfilled", value: { modelUsed: "primary", retries: 1 } });
  });

  it("throws a non-retryable error immediately, with no retry and no fallback", async () => {
    const calls: string[] = [];
    const failure = http(401);
    const result = await settle(runWithFallback(["primary", "fallback"], async (m) => { calls.push(m); throw failure; }, { timeoutMs: 1000 }));
    expect(calls).toEqual(["primary"]);
    expect(result).toEqual({ status: "rejected", reason: failure });
  });

  it("waits for the server-provided retry delay before retrying", async () => {
    const times: number[] = [];
    let n = 0;
    const run = runWithFallback(["m"], async () => { times.push(Date.now()); if (n++ === 0) throw http(429, { message: "Please try again in 4s" }); return "ok"; }, { timeoutMs: 60_000 });
    await settle(run);
    expect(times).toHaveLength(2);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(4000);
  });

  it("caps an excessive server delay", async () => {
    const times: number[] = [];
    let n = 0;
    const run = runWithFallback(["m"], async () => { times.push(Date.now()); if (n++ === 0) throw http(429, { headers: { "retry-after": "86400" } }); return "ok"; }, { timeoutMs: 60_000, maxDelayMs: 5000 });
    await settle(run);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeLessThanOrEqual(5000);
  });

  it("rejects when an attempt exceeds the timeout, without retrying", async () => {
    let calls = 0;
    const result = await settle(runWithFallback(["m", "f"], () => { calls++; return new Promise<string>(() => undefined); }, { timeoutMs: 500 }));
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
  });

  it("aborts the attempt's signal when it times out", async () => {
    let signal: AbortSignal | undefined;
    await settle(runWithFallback(["m"], (_m, s) => { signal = s; return new Promise<string>(() => undefined); }, { timeoutMs: 500 }));
    expect(signal?.aborted).toBe(true);
  });

  it("throws ModelsExhaustedError, carrying only kinds, when every model fails retryably", async () => {
    const secret = "gsk_" + "a1B2c3D4e5F6g7H8";
    const result = await settle(runWithFallback(["a", "b"], async () => { throw http(503, { message: secret }); }, { timeoutMs: 1000 }));
    expect(result.status).toBe("rejected");
    const error = (result as PromiseRejectedResult).reason as ModelsExhaustedError;
    expect(error).toBeInstanceOf(ModelsExhaustedError);
    expect(error.attempts).toEqual([
      { model: "a", kind: "server" }, { model: "a", kind: "server" }, { model: "b", kind: "server" }, { model: "b", kind: "server" },
    ]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.attempts)).not.toContain(secret);
  });

  it("honours maxRetries and rejects an empty model list", async () => {
    const calls: string[] = [];
    await settle(runWithFallback(["a"], async (m) => { calls.push(m); throw http(503); }, { timeoutMs: 1000, maxRetries: 0 }));
    expect(calls).toEqual(["a"]);
    const empty = await settle(runWithFallback([], async () => "x", { timeoutMs: 1000 }));
    expect(empty.status).toBe("rejected");
  });
});
