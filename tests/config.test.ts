import { describe, expect, it } from "vitest";
import { attemptModels, loadConfig, loadProxyConfig, toSafeView } from "../src/config.js";

const FAKE_KEY = "gsk_FAKEKEY1234567890abcdefghij";
const BASE = "http://proxy:8080/openai/v1";

describe("loadProxyConfig (proxy side)", () => {
  it("returns the key and the default port, frozen", () => {
    const cfg = loadProxyConfig({ GROQ_API_KEY: FAKE_KEY });
    expect(cfg.groqApiKey).toBe(FAKE_KEY);
    expect(cfg.port).toBe(8080);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it.each([undefined, "", "   "])("throws naming GROQ_API_KEY when it is %j", (value) => {
    expect(() => loadProxyConfig({ GROQ_API_KEY: value })).toThrow(/GROQ_API_KEY/);
  });

  it("honours PORT and rejects an invalid one", () => {
    expect(loadProxyConfig({ GROQ_API_KEY: FAKE_KEY, PORT: "9000" }).port).toBe(9000);
    expect(() => loadProxyConfig({ GROQ_API_KEY: FAKE_KEY, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadProxyConfig({ GROQ_API_KEY: FAKE_KEY, PORT: "70000" })).toThrow(/PORT/);
  });

  it("never exposes the key in a safe view", () => {
    const cfg = loadProxyConfig({ GROQ_API_KEY: FAKE_KEY });
    const view = toSafeView(cfg);
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
    expect(view.port).toBe(8080);
    expect(Object.isFrozen(view)).toBe(true);
  });
});

describe("loadConfig (agent side)", () => {
  it("returns the proxy URL and default models, frozen", () => {
    const cfg = loadConfig({ GROQ_BASE_URL: BASE });
    expect(cfg.groqBaseUrl).toBe(BASE);
    expect(cfg.reviewerModel).toBeTruthy();
    expect(cfg.coordinatorModel).toBeTruthy();
    expect(cfg.verifierModel).toBeTruthy();
    expect(cfg.fallbackModel).toBeTruthy();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.timeouts)).toBe(true);
  });

  it("throws naming GROQ_BASE_URL when it is missing or empty", () => {
    expect(() => loadConfig({})).toThrow(/GROQ_BASE_URL/);
    expect(() => loadConfig({ GROQ_BASE_URL: "" })).toThrow(/GROQ_BASE_URL/);
  });

  it("rejects a GROQ_BASE_URL that is not an http(s) URL", () => {
    expect(() => loadConfig({ GROQ_BASE_URL: "not a url" })).toThrow(/GROQ_BASE_URL/);
    expect(() => loadConfig({ GROQ_BASE_URL: "file:///etc/passwd" })).toThrow(/GROQ_BASE_URL/);
  });

  it("throws if GROQ_API_KEY is present in the agent env at all, without echoing it", () => {
    for (const value of [FAKE_KEY, ""]) {
      let message = "";
      try {
        loadConfig({ GROQ_BASE_URL: BASE, GROQ_API_KEY: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/GROQ_API_KEY/);
      if (value) expect(message).not.toContain(value);
    }
  });

  it("lets env override the model IDs", () => {
    const cfg = loadConfig({
      GROQ_BASE_URL: BASE,
      REVIEWER_MODEL: "model-a",
      COORDINATOR_MODEL: "model-b",
      VERIFIER_MODEL: "model-c",
      FALLBACK_MODEL: "model-d",
    });
    expect([cfg.reviewerModel, cfg.coordinatorModel, cfg.verifierModel, cfg.fallbackModel]).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
    ]);
  });

  it("bounds retries and keeps reviewer concurrency low by default", () => {
    const cfg = loadConfig({ GROQ_BASE_URL: BASE });
    expect(cfg.maxRetries).toBeGreaterThanOrEqual(1);
    expect(cfg.maxRetries).toBeLessThanOrEqual(3);
    expect(cfg.reviewerConcurrency).toBe(1);
  });

  it("uses the documented timeouts", () => {
    const { timeouts } = loadConfig({ GROQ_BASE_URL: BASE });
    expect(timeouts).toEqual({
      taskMs: 5 * 60_000,
      codeQualityTaskMs: 10 * 60_000,
      overallMs: 25 * 60_000,
      deadlineMs: 25 * 60_000,
      inactivityMs: 60_000,
      heartbeatMs: 30_000,
      abortGraceMs: 60_000,
    });
  });

  it("makes the retry count configurable, including 0, and keeps the default", () => {
    expect(loadConfig({ GROQ_BASE_URL: BASE }).maxRetries).toBe(2);
    expect(loadConfig({ GROQ_BASE_URL: BASE, REVIEW_MAX_RETRIES: "0" }).maxRetries).toBe(0);
    expect(loadConfig({ GROQ_BASE_URL: BASE, REVIEW_MAX_RETRIES: "5" }).maxRetries).toBe(5);
    for (const bad of ["6", "-1", "1.5", "x"]) expect(() => loadConfig({ GROQ_BASE_URL: BASE, REVIEW_MAX_RETRIES: bad })).toThrow(/REVIEW_MAX_RETRIES/);
  });

  it("uses no fallback model when retries are 0", () => {
    const cfg = (r: string) => loadConfig({ GROQ_BASE_URL: BASE, REVIEW_MAX_RETRIES: r, FALLBACK_MODEL: "big" });
    expect(attemptModels(cfg("0"), "small")).toEqual(["small"]);
    expect(attemptModels(cfg("1"), "small")).toEqual(["small", "big"]);
    expect(attemptModels(cfg("1"), "big")).toEqual(["big"]);
  });

  it("makes the hard deadline configurable in minutes", () => {
    expect(loadConfig({ GROQ_BASE_URL: BASE, REVIEW_DEADLINE_MINUTES: "3" }).timeouts.deadlineMs).toBe(180_000);
    expect(loadConfig({ GROQ_BASE_URL: BASE, REVIEW_TIMEOUT_SCALE: "2" }).timeouts.deadlineMs).toBe(50 * 60_000);
    for (const bad of ["0", "241", "x"]) expect(() => loadConfig({ GROQ_BASE_URL: BASE, REVIEW_DEADLINE_MINUTES: bad })).toThrow(/REVIEW_DEADLINE_MINUTES/);
  });

  it("does not put a key in its serialised form", () => {
    expect(JSON.stringify(loadConfig({ GROQ_BASE_URL: BASE }))).not.toMatch(/gsk_|api[_-]?key/i);
  });
});
