import { describe, expect, it } from "vitest";
import { scrubProviderError, usageOf } from "../../src/agents/scrub.js";
import { classifyError } from "../../src/resilience/errors.js";
import { loadConfig } from "../../src/config.js";

describe("scrubProviderError: step limit", () => {
  it("keeps a step-limit failure recognisable (and non-retryable) after scrubbing", () => {
    const scrubbed = scrubProviderError(Object.assign(new Error("secret detail"), { name: "StepLimitExceeded" }));
    expect(scrubbed.message).toBe("provider_step_limit");
    expect(classifyError(scrubbed)).toEqual({ retryable: false, kind: "step_limit" });
  });
});

describe("scrubProviderError", () => {
  it("keeps an allow-listed OpenCode error name but never its message or data", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const scrubbed = scrubProviderError({ name: "MessageAbortedError", message: `aborted ${secret}`, data: { message: secret } });
    expect(scrubbed).toMatchObject({ sdkName: "MessageAbortedError" });
    expect(JSON.stringify({ ...scrubbed, text: scrubbed.message })).not.toContain(secret);
  });

  it("drops an unknown error name", () => {
    expect(scrubProviderError({ name: "SomethingPrivateAboutAcmeCorp" })).not.toHaveProperty("sdkName");
  });
});

describe("scrubProviderError: lifecycle additions", () => {
  it("keeps a transport failure retryable after scrubbing, and distinct from a server error", () => {
    const scrubbed = scrubProviderError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }));
    expect(classifyError(scrubbed)).toMatchObject({ retryable: true, kind: "transport" });
    expect(scrubbed.message).toBe("provider_transport");
    expect(scrubbed).not.toHaveProperty("status");
  });

  it("keeps OpenCode's ContextOverflowError name and a non-retryable overflow classification", () => {
    const scrubbed = scrubProviderError({ name: "ContextOverflowError", data: { message: "secret body text", responseBody: "{\"x\":1}" } });
    expect(scrubbed).toMatchObject({ sdkName: "ContextOverflowError", status: 413 });
    expect(classifyError(scrubbed)).toEqual({ retryable: false, kind: "context_overflow" });
    expect(JSON.stringify({ ...scrubbed, text: scrubbed.message })).not.toContain("secret body text");
  });

  it("carries known token usage through scrubbing but only as plain numbers", () => {
    expect(scrubProviderError({ name: "APIError", status: 429, usage: { input: 120, output: 7, complete: false } })).toMatchObject({ usage: { input: 120, output: 7, complete: false } });
    expect(usageOf({ usage: { input: "1; DROP", output: 3 } })).toBeUndefined();
    expect(usageOf({ usage: { input: -1, output: 3 } })).toBeUndefined();
    expect(usageOf(undefined)).toBeUndefined();
    expect(scrubProviderError(new Error("x"))).not.toHaveProperty("usage");
  });
});

describe("REVIEW_TIMEOUT_SCALE", () => {
  const base = { GROQ_BASE_URL: "http://proxy:8080/openai/v1" };

  it("defaults to 1 and scales task and overall timeouts", () => {
    const one = loadConfig(base).timeouts;
    const three = loadConfig({ ...base, REVIEW_TIMEOUT_SCALE: "3" }).timeouts;
    expect(three.taskMs).toBe(one.taskMs * 3);
    expect(three.codeQualityTaskMs).toBe(one.codeQualityTaskMs * 3);
    expect(three.overallMs).toBe(one.overallMs * 3);
    expect(three.heartbeatMs).toBe(one.heartbeatMs);
  });

  it("rejects values outside 1 to 10", () => {
    for (const bad of ["0", "11", "-1", "abc", "1.5"]) expect(() => loadConfig({ ...base, REVIEW_TIMEOUT_SCALE: bad })).toThrow(/REVIEW_TIMEOUT_SCALE|Invalid/);
  });
});

describe("session lifecycle config", () => {
  const base = { GROQ_BASE_URL: "http://proxy:8080/openai/v1" };

  it("defaults to a bounded retry budget, short per-request transport timeouts and a cleanup grace", () => {
    const c = loadConfig(base);
    expect(c.session).toMatchObject({ maxProviderRetries: 5, pollMs: 1000, requestTimeoutMs: 30_000, maxPollFailures: 2 });
    expect(c.timeouts.abortGraceMs).toBeGreaterThan(c.session.cleanupWaitMs);
    // a transport timeout must never be the thing that ends an attempt early
    expect(c.session.requestTimeoutMs).toBeLessThan(c.timeouts.taskMs);
  });

  it("reads REVIEW_SESSION_RETRIES and rejects values outside 1 to 20", () => {
    expect(loadConfig({ ...base, REVIEW_SESSION_RETRIES: "9" }).session.maxProviderRetries).toBe(9);
    for (const bad of ["0", "21", "-1", "x", "2.5"]) expect(() => loadConfig({ ...base, REVIEW_SESSION_RETRIES: bad })).toThrow(/REVIEW_SESSION_RETRIES|Invalid/);
  });

  it("reads REVIEW_INVESTIGATION_STEPS (default 10) and rejects values outside 1 to 50", () => {
    expect(loadConfig(base).session.maxInvestigationSteps).toBe(10);
    expect(loadConfig({ ...base, REVIEW_INVESTIGATION_STEPS: "25" }).session.maxInvestigationSteps).toBe(25);
    for (const bad of ["0", "51", "-1", "x", "2.5"]) expect(() => loadConfig({ ...base, REVIEW_INVESTIGATION_STEPS: bad })).toThrow(/REVIEW_INVESTIGATION_STEPS|Invalid/);
  });

  it("does not scale the per-request transport timeout with REVIEW_TIMEOUT_SCALE", () => {
    expect(loadConfig({ ...base, REVIEW_TIMEOUT_SCALE: "3" }).session.requestTimeoutMs).toBe(30_000);
  });
});
