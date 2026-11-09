import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { classifyError } from "../src/resilience/errors.js";
import { scrubProviderError } from "../src/agents/scrub.js";

const BASE = { GROQ_BASE_URL: "http://proxy:8080/openai/v1" };

describe("REVIEW_HISTORY_BUDGET_BYTES", () => {
  it("is off by default, so existing runs are unchanged", () => {
    expect(loadConfig(BASE).session.historyBudgetBytes).toBe(0);
    expect(loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: "" }).session.historyBudgetBytes).toBe(0);
    expect(loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: "0" }).session.historyBudgetBytes).toBe(0);
  });

  it("accepts 2000 to 500000", () => {
    expect(loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: "8000" }).session.historyBudgetBytes).toBe(8000);
    expect(loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: "2000" }).session.historyBudgetBytes).toBe(2000);
    expect(loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: "500000" }).session.historyBudgetBytes).toBe(500000);
  });

  it.each(["1", "1999", "500001", "-1", "abc", "8e3", "1.5"])("rejects %j with a message naming the variable", (value) => {
    expect(() => loadConfig({ ...BASE, REVIEW_HISTORY_BUDGET_BYTES: value })).toThrow(/REVIEW_HISTORY_BUDGET_BYTES/);
  });
});

describe("history pruning failures are tooling failures, never retried", () => {
  it("classifies the driver's error and the proxy's 403 as tooling", () => {
    expect(classifyError({ name: "HistoryPruningFailed" })).toEqual({ retryable: false, kind: "tooling" });
    const proxy = { status: 403, data: { message: "{\"error\":{\"code\":\"history_pruning_inactive\"}}" } };
    expect(classifyError(proxy)).toEqual({ retryable: false, kind: "tooling" });
  });

  it("does not mistake an ordinary 403 for it", () => {
    expect(classifyError({ status: 403, message: "forbidden" }).kind).toBe("auth");
  });

  it("survives scrubbing as a tooling error", () => {
    const scrubbed = scrubProviderError({ name: "HistoryPruningFailed", message: "contains /secret/path" });
    expect(classifyError(scrubbed)).toEqual({ retryable: false, kind: "tooling" });
    expect(scrubbed.message).not.toContain("secret");
  });
});
