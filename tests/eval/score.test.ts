import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRun, type Adjudication } from "../../eval/load.js";
import { fingerprint, scoreRun, type ScoreResult } from "../../eval/score.js";
import { CONSUMER_FINDING, FIXTURES, HEAD_CLEAN, finding, leanRun, syntheticLabels } from "./helpers.js";

const labels = syntheticLabels();
const DEMO = join(FIXTURES, "demo-sqli", "cra-demo-evidence.json");
const score = (dir: string, caseId: string | null, adjudications: readonly Adjudication[] = []): ScoreResult =>
  scoreRun({ labels, caseId, run: loadRun(dir), adjudications, recheck: null, prices: null });
const adj = (runId: string, findingIndex: number, f: Parameters<typeof fingerprint>[0], verdict: Adjudication["verdict"], caseId = "buggy"): Adjudication =>
  ({ caseId, runId, findingIndex, fingerprint: fingerprint(f), verdict, note: "checked by hand against the source" });

describe("a review skipped because there was nothing to review", () => {
  it("keeps its reason, so it is never read as a review in which a model looked and found nothing", () => {
    const dir = leanRun("skipped", { status: "complete", reason: "nothing_to_review" });
    expect(loadRun(dir).reason).toBe("nothing_to_review");
    // No model looked, so a skipped clean case is not evidence of a low false-positive rate.
    expect(score(dir, "clean_same_head")).toMatchObject({ completion: { status: "complete", reason: "nothing_to_review" }, cleanControl: "not_scored", detectionNote: "nothing_to_review" });
    // A skipped buggy case is still a miss: the tool let the bug through.
    expect(score(dir, "buggy")).toMatchObject({ completion: { reason: "nothing_to_review" }, detection: "missed", detectionNote: "nothing_to_review" });
  });

  it("still has no reason for an ordinary complete review, and refuses any other reason on a complete one", () => {
    expect(loadRun(leanRun("ordinary", { status: "complete" })).reason).toBeNull();
    expect(() => loadRun(leanRun("odd", { status: "complete", reason: "looked_fine" }))).toThrow();
  });
});

describe("incomplete reviews are never credited", () => {
  const incomplete = ["legacy-case001-run1", "legacy-case001-run2", "legacy-case001-run3", "lean-case001-attempt1", "lean-case001-attempt2"];
  it.each(incomplete)("%s: no detection credit and no clean pass", (name) => {
    for (const caseId of ["buggy", "clean_same_head"]) {
      const r = score(join(FIXTURES, name), caseId);
      expect(r.completion.status).toBe("incomplete");
      expect(r.detection).toBe("not_scored");
      expect(r.detectionNote).toBe("incomplete");
      expect(r.cleanControl).toBe(caseId === "buggy" ? "not_applicable" : "not_scored");
      expect(r.falsePositives).toEqual({ count: 0, pendingReview: 0 });
    }
  });

  it("findings carried by an incomplete review are listed but not scored, even if adjudicated", () => {
    const dir = leanRun("inc", { status: "incomplete", reason: "findings_invalid", findings: [CONSUMER_FINDING] });
    const r = score(dir, "buggy", [adj("inc", 0, CONSUMER_FINDING, "correct")]);
    expect(r.detection).toBe("not_scored");
    expect(r.findings[0]).toMatchObject({ class: "unscored", verdict: "unscored" });
    expect(r.unusedAdjudications).toEqual([{ findingIndex: 0, reason: "run_not_scored" }]);
    expect(r.final).toBe(true);
  });

  it("reads the recorded reasons, tokens and request metrics of the historical runs", () => {
    const names = ["legacy-case001-run1", "legacy-case001-run2", "legacy-case001-run3"];
    expect(names.map((n) => loadRun(join(FIXTURES, n)).reason)).toEqual(["investigation_truncated", "model_context_overflow", "model_context_overflow"]);
    expect(loadRun(join(FIXTURES, "legacy-case001-run1")).metrics).toMatchObject({ tokensIn: 61479, tokensOut: 747, tokensLowerBound: false, toolCalls: 9, retries: 3 });
    expect(loadRun(join(FIXTURES, "legacy-case001-run2")).metrics.tokensLowerBound).toBe(true);
    const a1 = loadRun(join(FIXTURES, "lean-case001-attempt1"));
    expect(a1.reason).toBe("provider_400_tool_use_failed");
    expect(a1.metrics).toMatchObject({ tokensIn: 15339, modelRequests: 6, toolCalls: 5, retries: 3, providerErrors: ["400_tool_use_failed"], durationMs: 91973 });
    expect(loadRun(join(FIXTURES, "lean-case001-attempt2")).metrics).toMatchObject({ modelRequests: 10, toolCalls: 9, retries: 8, providerErrors: ["429_rate_limit_exceeded"] });
  });
});

describe("the recorded SQL-injection demo", () => {
  it("is a usable input: complete, citation counted, metrics read, never detection-scored", () => {
    const r = score(DEMO, null);
    expect(r).toMatchObject({ source: "demo", caseId: null, detection: "not_scored", detectionNote: "unlabeled", cleanControl: "not_applicable" });
    expect(r.completion).toEqual({ status: "complete", reason: null });
    expect(r.citation).toMatchObject({ kept: 1, dropped: null, validity: null });
    expect(r.metrics).toMatchObject({ tokensIn: 7595, tokensOut: 727, modelRequests: 6, toolCalls: 4 });
    expect(r.suggestions).toBe(0);
  });
});

describe("a completed review with a regression label", () => {
  it("with no findings is a miss, decided without a human", () => {
    expect(score(leanRun("none"), "buggy")).toMatchObject({ detection: "missed", cleanControl: "not_applicable", final: true });
  });

  it("matching the labelled location is only a candidate: pending review, never a hit by itself", () => {
    const r = score(leanRun("cand", { findings: [CONSUMER_FINDING] }), "buggy");
    expect(r.detection).toBe("pending_review");
    expect(r.final).toBe(false);
    expect(r.findings[0]).toMatchObject({ class: "candidate", verdict: "pending", adjudicated: false });
    expect(r.findings[0]?.signals).toEqual({ locationRoles: ["unchanged_consumer"], conceptsMatched: 3, conceptsRequired: 3, namesConsumer: true, uncreditedClaims: [] });
  });

  it("a location match with the wrong cause is still only a candidate", () => {
    const wrong = finding({ file: "src/orders/store.ts", line: 15, claim: "Naming is unclear.", path: "load" });
    const r = score(leanRun("loc", { findings: [wrong] }), "buggy");
    expect(r.detection).toBe("pending_review");
    expect(r.findings[0]?.signals).toMatchObject({ locationRoles: ["changed_source"], conceptsMatched: 0 });
  });

  it("every required concept without the labelled location is also a candidate; a partial concept match is not", () => {
    const moved = finding({ file: "src/orders/checkout.ts", line: 99, claim: "The checkout path reads a stale cache entry from the store.", path: "x" });
    expect(score(leanRun("concept", { findings: [moved] }), "buggy").findings[0]?.class).toBe("candidate");
    const partial = finding({ file: "src/orders/checkout.ts", line: 99, claim: "Checkout is slow.", path: "x" });
    expect(score(leanRun("partial", { findings: [partial] }), "buggy").findings[0]?.class).toBe("unlabeled");
  });

  it("is resolved only by a written adjudication: correct, partial, incorrect", () => {
    const run = leanRun("adj", { findings: [CONSUMER_FINDING] });
    const id = loadRun(run).runId;
    expect(score(run, "buggy", [adj(id, 0, CONSUMER_FINDING, "correct")])).toMatchObject({ detection: "hit", final: true });
    expect(score(run, "buggy", [adj(id, 0, CONSUMER_FINDING, "partial")])).toMatchObject({ detection: "partial", final: true });
    expect(score(run, "buggy", [adj(id, 0, CONSUMER_FINDING, "incorrect")])).toMatchObject({ detection: "missed", final: true, falsePositives: { count: 1, pendingReview: 0 } });
  });

  it("ignores an adjudication for a different finding or an inapplicable verdict, and says so", () => {
    const run = leanRun("stale", { findings: [CONSUMER_FINDING] });
    const id = loadRun(run).runId;
    expect(score(run, "buggy", [adj(id, 0, finding({ claim: "different" }), "correct")])).toMatchObject({ detection: "pending_review", unusedAdjudications: [{ findingIndex: 0, reason: "fingerprint_mismatch" }] });
    expect(score(run, "buggy", [adj(id, 0, CONSUMER_FINDING, "false_positive")])).toMatchObject({ detection: "pending_review", unusedAdjudications: [{ findingIndex: 0, reason: "verdict_not_allowed_for_candidate" }] });
    expect(score(run, "buggy", [adj(id, 7, CONSUMER_FINDING, "correct")]).unusedAdjudications).toEqual([{ findingIndex: 7, reason: "no_such_finding" }]);
    expect(score(run, "buggy", [adj("another-run", 0, CONSUMER_FINDING, "correct")]).detection).toBe("pending_review");
  });

  it("does not assume findings outside the labelled ranges are false positives", () => {
    const extra = finding({ severity: "critical", claim: "Something else entirely." });
    const run = leanRun("extra", { findings: [CONSUMER_FINDING, extra] });
    const id = loadRun(run).runId;
    const base = [adj(id, 0, CONSUMER_FINDING, "correct")];
    const open = score(run, "buggy", base);
    expect(open).toMatchObject({ detection: "hit", falsePositives: { count: 0, pendingReview: 1 }, final: false });
    expect(open.findings[1]).toMatchObject({ class: "unlabeled", verdict: "pending" });
    expect(score(run, "buggy", [...base, adj(id, 1, extra, "false_positive")])).toMatchObject({ falsePositives: { count: 1, pendingReview: 0 }, final: true });
    expect(score(run, "buggy", [...base, adj(id, 1, extra, "valid_additional")])).toMatchObject({ falsePositives: { count: 0, pendingReview: 0 }, final: true });
    expect(score(run, "buggy", [...base, adj(id, 1, extra, "out_of_scope")]).falsePositives.count).toBe(0);
  });

  it("reports suggestions separately from false positives", () => {
    const run = leanRun("sugg", { findings: [finding({ severity: "suggestion" }), finding({ severity: "suggestion", claim: "b" })] });
    expect(score(run, "buggy")).toMatchObject({ suggestions: 2, falsePositives: { count: 0, pendingReview: 0 }, detection: "missed", final: true });
  });

  it("flags claims the label says to neither credit nor penalise, and leaves the decision to the human", () => {
    const claim = finding({ ...CONSUMER_FINDING, claim: `${CONSUMER_FINDING.claim} This could cause a double charge.` });
    const r = score(leanRun("unc", { findings: [claim] }), "buggy");
    expect(r.findings[0]?.signals?.uncreditedClaims).toEqual(["double[- ]?charg"]);
    expect(r.detection).toBe("pending_review");
  });

  it("notes when the text names the unchanged consumer symbol", () => {
    const named = finding({ ...CONSUMER_FINDING, claim: "Checkout.pay never re-checks it." });
    expect(score(leanRun("named", { findings: [named] }), "buggy").findings[0]?.signals?.namesConsumer).toBe(true);
    const unnamed = finding({ file: "src/orders/checkout.ts", line: 12, claim: "Checkout sees a stale cache entry.", path: "x" });
    expect(score(leanRun("unnamed", { findings: [unnamed] }), "buggy").findings[0]?.signals?.namesConsumer).toBe(false);
  });
});

describe("a completed review of a clean case", () => {
  it("with no warning or critical finding is a clean pass; suggestions do not count against it", () => {
    expect(score(leanRun("c1", { head: HEAD_CLEAN }), "clean")).toMatchObject({ cleanControl: "clean_pass", detection: "not_applicable" });
    const s = score(leanRun("c2", { head: HEAD_CLEAN, findings: [finding({ severity: "suggestion" })] }), "clean");
    expect(s).toMatchObject({ cleanControl: "clean_pass", suggestions: 1, falsePositives: { count: 0, pendingReview: 0 } });
  });

  it("with a warning or critical finding is a false positive, unless a human rules it out", () => {
    const f = finding({ severity: "warning" });
    const run = leanRun("c3", { head: HEAD_CLEAN, findings: [f] });
    const id = loadRun(run).runId;
    expect(score(run, "clean")).toMatchObject({ cleanControl: "false_positive", falsePositives: { count: 1, pendingReview: 0 }, final: true });
    expect(score(run, "clean", [adj(id, 0, f, "out_of_scope", "clean")])).toMatchObject({ cleanControl: "clean_pass", falsePositives: { count: 0 } });
  });
});

describe("provenance, label version and citation fields", () => {
  it("refuses a run whose commits are not the label's, and an unknown case", () => {
    expect(() => score(leanRun("p1", { head: HEAD_CLEAN }), "buggy")).toThrow(/head commit does not match/);
    expect(() => score(leanRun("p2"), "nope")).toThrow(/unknown case/);
  });

  it("records the label content hash in every result", () => {
    const results = [score(leanRun("h1"), "buggy"), score(DEMO, null), score(join(FIXTURES, "legacy-case001-run1"), "buggy")];
    expect(results.map((r) => r.labels.sha256)).toEqual([labels.sha256, labels.sha256, labels.sha256]);
    expect(labels.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0]?.provenance).toBe("verified");
  });

  it("computes citation validity from kept and dropped findings", () => {
    const run = leanRun("cit", { findings: [finding(), finding({ claim: "b" })], dropped: ["line_out_of_range"] });
    expect(score(run, "buggy").citation).toMatchObject({ kept: 2, dropped: 1, validity: 0.6667, recheck: null });
    expect(score(leanRun("cit0"), "buggy").citation.validity).toBeNull();
  });

  it("estimates cost only when prices are given", () => {
    const run = loadRun(leanRun("cost", { tokensIn: 2_000_000, tokensOut: 1_000_000 }));
    const base = { labels, caseId: "buggy", run, adjudications: [], recheck: null };
    expect(scoreRun({ ...base, prices: null }).estimatedCostUsd).toBeNull();
    expect(scoreRun({ ...base, prices: { inPerMillion: 0.5, outPerMillion: 1 } }).estimatedCostUsd).toBe(2);
  });
});

describe("determinism", () => {
  it("gives byte-identical results for the same inputs, wherever the artifacts sit", () => {
    const a = JSON.stringify(score(leanRun("same", { findings: [CONSUMER_FINDING] }), "buggy"));
    const b = JSON.stringify(score(leanRun("same", { findings: [CONSUMER_FINDING] }), "buggy"));
    expect(a).toBe(b);
    const h = (n: string): string => JSON.stringify(score(join(FIXTURES, n), "buggy"));
    expect(h("lean-case001-attempt2")).toBe(h("lean-case001-attempt2"));
  });
});
