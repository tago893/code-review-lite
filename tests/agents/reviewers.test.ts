import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessCompletion } from "../../src/completion.js";
import { loadConfig, type Config } from "../../src/config.js";
import { createLogger } from "../../src/observability/log.js";
import { createMetrics } from "../../src/observability/metrics.js";
import { createRateLimitGate, runReviewers } from "../../src/agents/reviewers.js";
import { ReviewerSecurityError, type ReviewerRequest, type ReviewerRunner } from "../../src/agents/runner.js";
import type { Category } from "../../src/types.js";
import { fake } from "../safety/fakes.js";

const paths = { repoRoot: "/repo", sharedContextPath: "/review/context/shared-context.txt", patchDir: "/review/context/patches", promptDir: "/prompts" };
const baseConfig = loadConfig({ GROQ_BASE_URL: "http://proxy/v1", REVIEWER_MODEL: "small", FALLBACK_MODEL: "big" });
const cfg = (over: Partial<Config> = {}): Config => ({ ...baseConfig, ...over });

const finding = (category: string, over: Record<string, unknown> = {}) => ({
  category, severity: "warning", file: "src/a.ts", line: 3, evidence: "x", claim: "c", path: "p", ...over,
});
const out = (...items: unknown[]) => ({ raw: JSON.stringify(items), tokensIn: 100, tokensOut: 10 });
const http = (status: number, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

const lines: string[] = [];
const log = () => createLogger((l) => void lines.push(l));
beforeEach(() => { lines.length = 0; });

const run = (agents: Category[], runner: ReviewerRunner, config = cfg(), metrics = createMetrics()) =>
  runReviewers(agents, { runner, config, log: log(), paths, metrics });

describe("runReviewers", () => {
  it("collects every reviewer's findings, tagged with the reviewer", async () => {
    const runner: ReviewerRunner = { run: async (r) => out(finding(r.category)) };
    const result = await run(["code_quality", "security", "performance"], runner);
    expect(result.failed).toEqual([]);
    expect(result.findings.map((f) => f.reviewer)).toEqual(["code_quality", "security", "performance"]);
    expect(result.outcomes.every((o) => o.executed)).toBe(true);
  });

  it("builds the request from the paths and the category", async () => {
    const seen: ReviewerRequest[] = [];
    await run(["security"], { run: async (r) => { seen.push(r); return out(); } });
    expect(seen[0]).toMatchObject({ category: "security", model: "small", promptPath: "/prompts/security.md", repoRoot: "/repo", patchDir: "/review/context/patches" });
  });

  it("reports a failing reviewer in `failed` while the others still return findings", async () => {
    const runner: ReviewerRunner = { run: async (r) => { if (r.category === "security") throw new Error("boom"); return out(finding(r.category)); } };
    const result = await run(["code_quality", "security", "performance"], runner);
    expect(result.findings.map((f) => f.reviewer)).toEqual(["code_quality", "performance"]);
    expect(result.failed).toEqual([{ reviewer: "security", error: "model_unknown", failureClass: "model" }]);
    expect(result.outcomes.find((o) => o.reviewer === "security")?.executed).toBe(false);
    expect(assessCompletion(result.outcomes).completion).toBe("incomplete");
  });

  it("runs reviewers concurrently when the limit allows, collecting out-of-order results in input order", async () => {
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    const runner: ReviewerRunner = {
      run: (r) => new Promise((resolve) => { started.push(r.category); gates.set(r.category, () => resolve(out(finding(r.category)))); }),
    };
    const pending = run(["code_quality", "security"], runner, cfg({ reviewerConcurrency: 2 }));
    await vi.waitFor(() => expect(started).toHaveLength(2));
    gates.get("security")?.();
    gates.get("code_quality")?.();
    const result = await pending;
    expect(result.findings.map((f) => f.reviewer)).toEqual(["code_quality", "security"]);
  });

  it("runs one at a time with the default concurrency of 1 (shared provider rate limit)", async () => {
    let inFlight = 0;
    let peak = 0;
    const runner: ReviewerRunner = {
      run: async (r) => { peak = Math.max(peak, ++inFlight); await new Promise((res) => setTimeout(res, 5)); inFlight--; return out(finding(r.category)); },
    };
    await run(["code_quality", "security", "performance"], runner);
    expect(peak).toBe(1);
  });

  it("never puts error text in `failed`, the log or the result", async () => {
    const secret = fake.groq();
    const runner: ReviewerRunner = { run: async () => { throw new Error(`provider said ${secret}`); } };
    const result = await run(["security"], runner);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

describe("runReviewers: failures stay distinguishable from a clean review", () => {
  it("marks a sanitisation failure with its own class and does not retry it or fall back", async () => {
    let calls = 0;
    const runner: ReviewerRunner = { run: async () => { calls++; throw new ReviewerSecurityError("phase2_notes", "too_large"); } };
    const result = await run(["security"], runner);
    expect(calls).toBe(1);
    expect(result.failed).toEqual([{ reviewer: "security", error: "sanitization_failed:phase2_notes", failureClass: "sanitization" }]);
    expect(assessCompletion(result.outcomes, []).completion).toBe("incomplete");
  });

  it("treats unparsable output as a failure of class `output`, never as zero findings", async () => {
    const result = await run(["security"], { run: async () => ({ raw: "I could not produce JSON", tokensIn: 1, tokensOut: 1 }) });
    expect(result.findings).toEqual([]);
    expect(result.failed).toEqual([{ reviewer: "security", error: "unusable_output", failureClass: "output" }]);
    expect(assessCompletion(result.outcomes).completion).toBe("incomplete");
  });

  it("accepts an explicit empty list as a clean result", async () => {
    const result = await run(["security"], { run: async () => out() });
    expect(result.failed).toEqual([]);
    expect(assessCompletion(result.outcomes).completion).toBe("complete");
  });

  it("keeps the accepted findings and the rejected-item info for a partly valid response", async () => {
    const result = await run(["security"], { run: async () => out(finding("security"), finding("security", { severity: "bogus" })) });
    expect(result.findings).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result.outcomes[0]?.parsed?.rejected).toEqual([{ index: 1, fields: ["severity"] }]);
    expect(assessCompletion(result.outcomes).degraded).toEqual(["security: 1 finding(s) dropped as invalid"]);
  });
});

describe("runReviewers: retries, fallback and rate limits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = async <T>(p: Promise<T>): Promise<T> => { const done = p.then((v) => v); await vi.runAllTimersAsync(); return done; };

  it("retries a transient error on the same model, then succeeds, and records the retry", async () => {
    const models: string[] = [];
    const runner: ReviewerRunner = { run: async (r) => { models.push(r.model); if (models.length === 1) throw http(503); return out(finding("security")); } };
    const result = await settle(run(["security"], runner));
    expect(models).toEqual(["small", "small"]);
    expect(result.findings).toHaveLength(1);
    expect(result.metrics?.snapshot()).toMatchObject({ retries: 1, fallbacks: 0 });
  });

  it("falls back to the other model after the primary is exhausted, and records it", async () => {
    const models: string[] = [];
    const runner: ReviewerRunner = { run: async (r) => { models.push(r.model); if (r.model === "small") throw http(503); return out(finding("security")); } };
    const result = await settle(run(["security"], runner));
    expect(models).toEqual(["small", "small", "small", "big"]);
    expect(result.findings).toHaveLength(1);
    expect(result.metrics?.snapshot()).toMatchObject({ fallbacks: 1 });
  });

  it("bounds total attempts when every model keeps failing, then reports models_exhausted (incomplete)", async () => {
    let calls = 0;
    const runner: ReviewerRunner = { run: async () => { calls++; throw http(429); } };
    const result = await settle(run(["security"], runner));
    expect(calls).toBe(6); // 2 models x (1 try + maxRetries 2)
    expect(result.failed).toEqual([{ reviewer: "security", error: "models_exhausted", failureClass: "model" }]);
    expect(assessCompletion(result.outcomes).completion).toBe("incomplete");
  });

  it("does not retry or fall back on an auth failure", async () => {
    let calls = 0;
    const result = await settle(run(["security"], { run: async () => { calls++; throw http(401); } }));
    expect(calls).toBe(1);
    expect(result.failed[0]).toEqual({ reviewer: "security", error: "model_auth", failureClass: "model" });
  });

  it("makes a reviewer that starts later wait out another reviewer's server-provided rate-limit delay", async () => {
    const starts: Record<string, number> = {};
    let securityCalls = 0;
    const runner: ReviewerRunner = {
      run: async (r) => {
        if (r.category === "security" && securityCalls++ === 0) throw http(429, { headers: { "retry-after-ms": "4000" } });
        starts[r.category] ??= Date.now();
        return out();
      },
    };
    const t0 = Date.now();
    await settle(run(["security", "code_quality", "performance"], runner, cfg({ reviewerConcurrency: 2 })));
    expect((starts["performance"] ?? 0) - t0).toBeGreaterThanOrEqual(4000);
  });

  it("records tokens per reviewer", async () => {
    const result = await settle(run(["security"], { run: async () => out() }));
    expect(result.metrics?.snapshot().tokens).toMatchObject({ input: 100, output: 10, byAgent: { security: { input: 100, output: 10 } } });
  });
});

describe("createRateLimitGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds waiters until the noted delay passes, ignores zero, and caps absurd delays", async () => {
    const gate = createRateLimitGate();
    let released = false;
    gate.note(0);
    await gate.wait();
    gate.note(4000);
    void gate.wait().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);

    gate.note(86_400_000);
    let capped = false;
    void gate.wait().then(() => { capped = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(capped).toBe(true);
  });
});

describe("runReviewers: attempt tracing and usage", () => {
  const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  it("gives every attempt an id, passes it to the runner and logs start, failure decisions and success", async () => {
    vi.useFakeTimers();
    try {
      const ids: (string | undefined)[] = [];
      let n = 0;
      const runner: ReviewerRunner = { run: async (r) => { ids.push(r.attemptId); if (n++ === 0) throw http(429, { headers: { "retry-after": "2" }, usage: { input: 40, output: 0, complete: false } }); return out(); } };
      const pending = run(["security"], runner);
      await vi.runAllTimersAsync();
      await pending;
      expect(ids).toEqual(["security#1", "security#2"]);
      const log = events();
      expect(log.filter((e) => e["event"] === "attempt_start").map((e) => e["attemptId"])).toEqual(["security#1", "security#2"]);
      expect(log.find((e) => e["event"] === "attempt_failed")).toMatchObject({ attemptId: "security#1", reviewer: "security", model: "small", kind: "rate_limit", decision: "retry_same_model", delayMs: 2000, usage: { input: 40, output: 0, complete: false } });
      expect(log.find((e) => e["event"] === "attempt_succeeded")).toMatchObject({ attemptId: "security#2" });
    } finally { vi.useRealTimers(); }
  });

  it("keeps the tokens that failed attempts are known to have used, as a lower bound, and counts silent ones as unreported", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const runner: ReviewerRunner = { run: async () => { n++; throw http(429, n === 1 ? { usage: { input: 700, output: 20, complete: false } } : {}); } };
      const pending = run(["security"], runner, cfg({ maxRetries: 0 }));
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.failed).toEqual([{ reviewer: "security", error: "models_exhausted", failureClass: "model" }]);
      const snap = result.metrics?.snapshot();
      expect(snap?.tokens).toMatchObject({ input: 700, output: 20 });
      expect(snap?.usage).toEqual({ unreportedRuns: 1, lowerBound: true });
    } finally { vi.useRealTimers(); }
  });

  it("keeps usage from a timed-out or overflowed attempt (a single non-retryable failure)", async () => {
    const runner: ReviewerRunner = { run: async () => { throw Object.assign(new Error("x"), { name: "ProviderError", status: 413, usage: { input: 900, output: 3, complete: false } }); } };
    const result = await run(["security"], runner);
    expect(result.failed[0]).toMatchObject({ error: "model_context_overflow" });
    expect(result.metrics?.snapshot().tokens).toMatchObject({ input: 900, output: 3 });
  });

  it("records unknown usage on success as unreported, not as zero", async () => {
    const runner: ReviewerRunner = { run: async () => ({ raw: "[]", tokensIn: 0, tokensOut: 0, tokensKnown: false }) };
    const result = await run(["security"], runner);
    expect(result.metrics?.snapshot().usage).toEqual({ unreportedRuns: 1, lowerBound: true });
  });

  it("logs a failure with no usage at all as unknown, never as a zero count", async () => {
    const runner: ReviewerRunner = { run: async () => { throw new Error("boom"); } };
    const result = await run(["security"], runner);
    expect(result.metrics?.snapshot().usage.unreportedRuns).toBe(1);
    expect(JSON.stringify(events().filter((e) => e["event"] === "attempt_failed"))).not.toContain('"input":0');
  });
});
