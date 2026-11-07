import { describe, expect, it } from "vitest";
import { createMetrics } from "../../src/observability/metrics.js";

describe("createMetrics", () => {
  it("starts empty", () => {
    expect(createMetrics().snapshot()).toMatchObject({
      findings: { total: 0, byReviewer: {}, bySeverity: {}, byStatus: {} },
      tokens: { input: 0, output: 0, byAgent: {} },
      costUsd: 0,
      drops: { total: 0, byReason: {} },
      retries: 0,
      fallbacks: 0,
    });
  });

  it("counts findings by reviewer, severity and status", () => {
    const m = createMetrics()
      .recordFinding({ reviewer: "sec", severity: "warning" }, "semantically_supported")
      .recordFinding({ reviewer: "sec", severity: "critical" }, "independently_confirmed")
      .recordFinding({ reviewer: "perf", severity: "suggestion" }, "citation_valid");
    expect(m.snapshot().findings).toEqual({
      total: 3,
      byReviewer: { sec: 2, perf: 1 },
      bySeverity: { warning: 1, critical: 1, suggestion: 1 },
      byStatus: { semantically_supported: 1, independently_confirmed: 1, citation_valid: 1 },
    });
  });

  it("totals tokens per agent and overall, and accumulates cost", () => {
    const m = createMetrics().recordTokens("sec", 100, 20).recordTokens("sec", 50, 5).recordTokens("perf", 10, 1).recordCost(0.002).recordCost(0.003);
    expect(m.snapshot().tokens).toEqual({ input: 160, output: 26, byAgent: { sec: { input: 150, output: 25 }, perf: { input: 10, output: 1 } } });
    expect(m.snapshot().costUsd).toBeCloseTo(0.005, 10);
  });

  it("counts drops by reason, and retries and fallbacks", () => {
    const m = createMetrics().recordDrop("citation").recordDrop("citation").recordDrop("invalid").recordRetry().recordRetry().recordFallback();
    expect(m.snapshot()).toMatchObject({ drops: { total: 3, byReason: { citation: 2, invalid: 1 } }, retries: 2, fallbacks: 1 });
  });

  it("records the duration and the run's completion state", () => {
    const snap = createMetrics().recordDuration(1234).recordCompletion("incomplete").snapshot();
    expect(snap).toMatchObject({ durationMs: 1234, completion: "incomplete" });
  });

  it("is immutable: each record returns a new value and leaves the old one unchanged", () => {
    const a = createMetrics();
    const b = a.recordFinding({ reviewer: "r", severity: "warning" }, "citation_valid");
    expect(b).not.toBe(a);
    expect(a.snapshot().findings.total).toBe(0);
    expect(b.snapshot().findings.total).toBe(1);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.snapshot())).toBe(true);
    expect(Object.isFrozen(b.snapshot().findings.byReviewer)).toBe(true);
  });

  it("ignores negative or non-finite numbers rather than corrupting totals", () => {
    const m = createMetrics().recordTokens("a", -5, Number.NaN).recordCost(Number.POSITIVE_INFINITY).recordCost(-1);
    expect(m.snapshot().tokens.input).toBe(0);
    expect(m.snapshot().tokens.output).toBe(0);
    expect(m.snapshot().costUsd).toBe(0);
  });

  it("holds only counts and numbers: no finding text can enter a snapshot", () => {
    const m = createMetrics().recordFinding({ reviewer: "r", severity: "critical", claim: "SECRET TEXT" } as never, "citation_valid");
    expect(JSON.stringify(m.snapshot())).not.toContain("SECRET TEXT");
  });
});
