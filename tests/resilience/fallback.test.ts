import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsExhaustedError, runWithFallback, type AttemptEvent } from "../../src/resilience/fallback.js";

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

describe("runWithFallback: abandoned attempts", () => {
  it("waits for a timed-out attempt to finish its cleanup before it rejects", async () => {
    const order: string[] = [];
    const attempt = (_m: string, signal: AbortSignal): Promise<string> =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          // stands in for aborting and deleting the OpenCode session, which takes a moment
          setTimeout(() => { order.push("cleanup finished"); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, 300);
        });
      });
    const result = await settle(runWithFallback(["m"], attempt, { timeoutMs: 500, abortGraceMs: 5000 }));
    order.push("run rejected");
    expect(order).toEqual(["cleanup finished", "run rejected"]);
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError" });
  });

  it("still rejects after the grace period if the attempt never settles", async () => {
    const started = Date.now();
    const result = await settle(runWithFallback(["m"], () => new Promise<string>(() => undefined), { timeoutMs: 500, abortGraceMs: 2000 }));
    expect(result.status).toBe("rejected");
    expect(Date.now() - started).toBe(2500);
  });

  it("treats a success that arrives after the deadline as a timeout", async () => {
    const attempt = (): Promise<string> => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 700));
    const result = await settle(runWithFallback(["m"], attempt, { timeoutMs: 500, abortGraceMs: 5000 }));
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError" });
  });

  it("carries known usage from the abandoned attempt onto the timeout error", async () => {
    const attempt = (_m: string, signal: AbortSignal): Promise<string> =>
      new Promise<string>((_r, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError", usage: { input: 900, output: 40, complete: false } }))));
    const result = await settle(runWithFallback(["m"], attempt, { timeoutMs: 500 }));
    expect((result as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError", usage: { input: 900, output: 40, complete: false } });
  });

  it("never starts a replacement attempt while the previous one is still running", async () => {
    let running = 0; let maxRunning = 0;
    let n = 0;
    const attempt = async (): Promise<string> => {
      running++; maxRunning = Math.max(maxRunning, running);
      try { await new Promise((r) => setTimeout(r, 50)); if (n++ < 3) throw http(503); return "ok"; } finally { running--; }
    };
    await settle(runWithFallback(["a", "b"], attempt, { timeoutMs: 1000 }));
    expect(maxRunning).toBe(1);
  });
});

describe("runWithFallback: decisions and usage are observable", () => {
  it("reports every attempt start and failure with its decision, delay and known usage", async () => {
    const events: AttemptEvent[] = [];
    let n = 0;
    const attempt = async (): Promise<string> => {
      if (n++ < 2) throw http(429, { headers: { "retry-after": "3" }, usage: { input: 50, output: 1, complete: true } });
      return "ok";
    };
    await settle(runWithFallback(["a", "b"], attempt, { timeoutMs: 1000, maxRetries: 2, onEvent: (e) => events.push(e) }));
    expect(events).toEqual([
      { type: "start", model: "a", tryNo: 0 },
      { type: "failed", model: "a", tryNo: 0, kind: "rate_limit", decision: "retry_same_model", delayMs: 3000, usage: { input: 50, output: 1, complete: true } },
      { type: "start", model: "a", tryNo: 1 },
      { type: "failed", model: "a", tryNo: 1, kind: "rate_limit", decision: "retry_same_model", delayMs: 3000, usage: { input: 50, output: 1, complete: true } },
      { type: "start", model: "a", tryNo: 2 },
      { type: "succeeded", model: "a", tryNo: 2 },
    ]);
  });

  it("reports the fallback and exhaustion decisions, and records usage per failed attempt", async () => {
    const events: AttemptEvent[] = [];
    const result = await settle(runWithFallback(["a", "b"], async () => { throw http(503, { usage: { input: 10, output: 0, complete: false } }); }, { timeoutMs: 1000, maxRetries: 0, onEvent: (e) => events.push(e) }));
    expect(events.filter((e) => e.type === "failed").map((e) => (e as { decision: string }).decision)).toEqual(["fallback_model", "exhausted"]);
    expect(((result as PromiseRejectedResult).reason as ModelsExhaustedError).attempts).toEqual([
      { model: "a", kind: "server", usage: { input: 10, output: 0, complete: false } },
      { model: "b", kind: "server", usage: { input: 10, output: 0, complete: false } },
    ]);
  });

  it("reports a non-retryable failure as ending the run, and never reports error text", async () => {
    const events: AttemptEvent[] = [];
    await settle(runWithFallback(["a", "b"], async () => { throw http(413, { message: "SECRET-BODY" }); }, { timeoutMs: 1000, onEvent: (e) => events.push(e) }));
    expect(events).toEqual([{ type: "start", model: "a", tryNo: 0 }, { type: "failed", model: "a", tryNo: 0, kind: "context_overflow", decision: "stop_not_retryable" }]);
    expect(JSON.stringify(events)).not.toContain("SECRET-BODY");
  });

  describe("run-wide signal", () => {
    const reason = () => Object.assign(new Error("run deadline exceeded"), { name: "TimeoutError" });

    it("aborts the active attempt, waits for its cleanup, and does not retry or fall back", async () => {
      const controller = new AbortController();
      const calls: string[] = [];
      let cleaned = false;
      const attempt = (m: string, signal: AbortSignal): Promise<string> => {
        calls.push(m);
        return new Promise((_, reject) => signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; reject(signal.reason); }, 100)));
      };
      const pending = runWithFallback(["a", "b"], attempt, { timeoutMs: 60_000, signal: controller.signal });
      setTimeout(() => controller.abort(reason()), 500);
      const result = await settle(pending);
      expect(result).toMatchObject({ status: "rejected", reason: { name: "TimeoutError" } });
      expect(cleaned).toBe(true);
      expect(calls).toEqual(["a"]);
    });

    it("starts nothing when already aborted, and stops waiting between retries", async () => {
      const done = new AbortController();
      done.abort(reason());
      let calls = 0;
      const first = await settle(runWithFallback(["a"], async () => { calls += 1; return "x"; }, { timeoutMs: 1000, signal: done.signal }));
      expect(first.status).toBe("rejected");
      expect(calls).toBe(0);

      const controller = new AbortController();
      const attempt = async (): Promise<string> => { calls += 1; throw http(429, { headers: { "retry-after": "30" } }); };
      const pending = runWithFallback(["a", "b"], attempt, { timeoutMs: 1000, signal: controller.signal });
      setTimeout(() => controller.abort(reason()), 1000);
      expect((await settle(pending)).status).toBe("rejected");
      expect(calls).toBe(1);
    });
  });
});
