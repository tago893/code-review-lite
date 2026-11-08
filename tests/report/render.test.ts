import { describe, expect, it } from "vitest";
import { createMetrics } from "../../src/observability/metrics.js";
import { renderReport, type ReportData } from "../../src/report/render.js";
import type { LeveledFinding } from "../../src/verify/claims.js";

const finding = (over: Partial<LeveledFinding> = {}): LeveledFinding => ({
  id: "f1", category: "security", severity: "warning", file: "src/a.ts", line: 7, evidence: "db.query(sql)", claim: "possible injection",
  path: "req.body -> sql -> db.query", reviewer: "security", level: "semantically_supported", label: "model-assessed support (coordinator), not independently confirmed", ...over,
});

const data = (over: Partial<ReportData> = {}): ReportData => ({
  completion: "complete", verdict: "approved_with_comments", reasons: [], degraded: [], findings: [finding()], preexisting: [], linked: {}, notes: [], traces: {},
  failedReviewers: [], excluded: [], withheld: [], tier: "lite", range: { base: "a".repeat(40), head: "b".repeat(40) }, metrics: createMetrics().snapshot(), ...over,
});

describe("renderReport", () => {
  it("puts the verdict first and groups findings by category with severity, location, evidence and level", () => {
    const text = renderReport(data({ findings: [finding(), finding({ id: "f2", category: "performance", severity: "suggestion", label: "unconfirmed", level: "citation_valid", line: 9 })] }));
    expect(text.split("\n")[0]).toBe("# Review verdict: APPROVED WITH COMMENTS");
    expect(text.indexOf("### Security")).toBeLessThan(text.indexOf("### Performance"));
    expect(text).toContain("**warning** `src/a.ts:7`");
    expect(text).toContain("db.query(sql)");
    expect(text).toContain("level: model-assessed support (coordinator), not independently confirmed");
    expect(text).toContain("level: unconfirmed");
  });

  it("headlines an incomplete review as REVIEW INCOMPLETE with its reasons and failed reviewers", () => {
    const text = renderReport(data({ completion: "incomplete", verdict: "not_determined", reasons: ["blocked: x"], failedReviewers: [{ reviewer: "security", error: "models_exhausted", failureClass: "model" }], findings: [] }));
    expect(text.split("\n")[0]).toBe("# REVIEW INCOMPLETE");
    expect(text).toContain("blocked: x");
    expect(text).toContain("security: models_exhausted (model)");
    expect(text).toContain("incomplete review");
  });

  it("says 'No findings.' only for a complete review", () => {
    expect(renderReport(data({ findings: [], verdict: "approved" }))).toContain("No findings.");
  });

  it("notes capped severity, pre-existing findings, traces, excluded and withheld files", () => {
    const text = renderReport(data({
      findings: [finding({ cappedFrom: "critical" })], linked: { f1: ["scale"] }, preexisting: [finding({ id: "f9", claim: "old problem" })], notes: ["docs only"], traces: { f1: "read src/a.ts:7" },
      excluded: [{ path: "package-lock.json", kind: "lockfile", reason: "noise" }], withheld: [".env"],
    }));
    expect(text).toContain("reported as critical, capped to warning");
    expect(text).toContain("uses changed symbol(s) scale");
    expect(text).toContain("## Possibly pre-existing (not counted in the verdict)");
    expect(text).toContain("old problem");
    expect(text).toContain("docs only");
    expect(text).toContain("coordinator: read src/a.ts:7");
    expect(text).toContain("package-lock.json (lockfile: noise)");
    expect(text).toContain(".env");
  });

  it("uses a code fence longer than any backtick run in the evidence", () => {
    const text = renderReport(data({ findings: [finding({ evidence: "a ```` b\nsecond" })] }));
    expect(text).toContain("  `````");
  });

  it("redacts secrets anywhere in the report", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    expect(renderReport(data({ findings: [finding({ claim: `uses ${secret}`, evidence: `key=${secret}` })] }))).not.toContain(secret);
  });

  it("states that the review is advisory and prints metrics", () => {
    const text = renderReport(data({ metrics: createMetrics().recordTokens("security", 10, 5).recordRetry().recordDrop("citation").snapshot() }));
    expect(text).toContain("advisory");
    expect(text).toContain("tokens: 10 in / 5 out");
    expect(text).toContain("retries: 1");
    expect(text).toContain("citation=1");
  });
});

describe("renderReport: unknown and partial token usage", () => {
  it("says unknown, not zero, when no run reported usage", () => {
    const text = renderReport(data({ metrics: createMetrics().recordUnreportedTokens("code_quality").snapshot() }));
    expect(text).toContain("tokens: unknown (1 run reported no usage)");
    expect(text).not.toContain("tokens: 0 in / 0 out");
  });

  it("labels a partial total as a lower bound and states how many runs reported nothing", () => {
    const text = renderReport(data({ metrics: createMetrics().recordTokens("a", 1200, 80, false).recordUnreportedTokens("b").snapshot() }));
    expect(text).toContain("tokens: at least 1200 in / 80 out (lower bound; 1 run reported no usage)");
  });

  it("keeps the plain figure when every run reported complete usage", () => {
    expect(renderReport(data({ metrics: createMetrics().recordTokens("a", 7, 3).snapshot() }))).toContain("tokens: 7 in / 3 out");
  });
});
