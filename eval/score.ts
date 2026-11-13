import { createHash } from "node:crypto";
import { EvalInputError, type Adjudication, type AdjudicatedVerdict, type CaseLabel, type LoadedLabels, type Run, type RunFinding, type RunMetrics } from "./load.js";

// The scorer. Pure: the same inputs always give the same result. It reads labels and an artifact; nothing here can reach
// the reviewer, and the reviewer cannot import this folder (tests/eval/isolation.test.ts).
//
// Two dimensions are kept apart. COMPLETION says whether the review finished. DETECTION says what a finished review found.
// An incomplete review is never given detection credit and never a clean pass.
//
// Nothing is awarded for matching a labelled file or line. A finding that matches the label by location, or by every
// required concept, is only a CANDIDATE. A candidate becomes "correct" only through a written human adjudication, because
// the label's regexes and line ranges cannot show that the cross-file cause is actually established by the finding.

export type Detection = "hit" | "partial" | "missed" | "pending_review" | "not_applicable" | "not_scored";
export type CleanControl = "clean_pass" | "false_positive" | "not_scored" | "not_applicable";
export type FindingClass = "candidate" | "unlabeled" | "unscored";
export type FindingVerdict = AdjudicatedVerdict | "pending" | "suggestion" | "unscored";

export interface Signals {
  /** Roles of the accepted locations this finding's file and line fall inside. */
  readonly locationRoles: readonly string[];
  /** How many of the label's required concept patterns match the finding's claim, path and evidence text. */
  readonly conceptsMatched: number;
  readonly conceptsRequired: number;
  /** The finding's text names the symbol of the unchanged consumer (for example `confirm`). */
  readonly namesConsumer: boolean;
  /** Claims the label says must neither be credited nor penalised (for example double-selling). */
  readonly uncreditedClaims: readonly string[];
}

export interface FindingRecord {
  readonly index: number;
  /** Ties an adjudication to exactly this finding, so a stale adjudication cannot be applied to a different one. */
  readonly fingerprint: string;
  readonly file: string;
  readonly line: number;
  readonly severity: RunFinding["severity"];
  readonly class: FindingClass;
  readonly verdict: FindingVerdict;
  readonly adjudicated: boolean;
  readonly signals: Signals | null;
  /** Independent re-check against the benchmark repository, when one was supplied. */
  readonly citationRecheck: boolean | null;
}

export interface ScoreResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly source: Run["source"];
  readonly caseId: string | null;
  /** Which label file scored this result: the content hash is what makes a score reproducible. */
  readonly labels: { readonly sha256: string; readonly benchmark: string };
  readonly provenance: "verified" | "unverified";
  readonly completion: { readonly status: Run["status"]; readonly reason: string | null };
  readonly detection: Detection;
  readonly detectionNote: string | null;
  readonly cleanControl: CleanControl;
  readonly falsePositives: { readonly count: number; readonly pendingReview: number };
  readonly suggestions: number;
  /** False while any finding still needs a human decision. */
  readonly final: boolean;
  readonly citation: {
    readonly kept: number;
    readonly dropped: number | null;
    /** kept / (kept + dropped) by the reviewer's own check; null when nothing was cited or the artifact does not say. */
    readonly validity: number | null;
    readonly recheck: { readonly checked: number; readonly valid: number } | null;
  };
  readonly metrics: RunMetrics;
  readonly estimatedCostUsd: number | null;
  readonly findings: readonly FindingRecord[];
  readonly unusedAdjudications: readonly { readonly findingIndex: number; readonly reason: string }[];
}

export interface Prices { readonly inPerMillion: number; readonly outPerMillion: number }

export interface ScoreInput {
  readonly labels: LoadedLabels;
  /** null scores completion, citations and metrics only (for example the SQL-injection demo, which has no label). */
  readonly caseId: string | null;
  readonly run: Run;
  readonly adjudications: readonly Adjudication[];
  /** One result per finding, from recheckCitations, or null when no benchmark repository was given. */
  readonly recheck: readonly boolean[] | null;
  readonly prices: Prices | null;
}

const CANDIDATE_VERDICTS: ReadonlySet<AdjudicatedVerdict> = new Set(["correct", "partial", "incorrect"]);
const UNLABELED_VERDICTS: ReadonlySet<AdjudicatedVerdict> = new Set(["false_positive", "valid_additional", "out_of_scope"]);

const normalisePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function fingerprint(f: RunFinding): string {
  return createHash("sha256").update(`${normalisePath(f.file)}\n${f.line}\n${f.severity}\n${f.claim}`).digest("hex").slice(0, 16);
}

/** A run's commits must be the label's commits (a short id is accepted as a prefix). A mismatch is refused, never scored. */
function checkProvenance(run: Run, labels: LoadedLabels, label: CaseLabel): "verified" | "unverified" {
  const pairs: readonly (readonly [string | null, string, string])[] = [[run.baseSha, labels.labels.baseCommit, "base"], [run.headSha, label.headCommit, "head"]];
  let verified = true;
  for (const [actual, expected, name] of pairs) {
    if (actual === null) { verified = false; continue; }
    if (actual.length < 7 || !expected.startsWith(actual)) throw new EvalInputError(`${run.runId}: ${name} commit does not match the label for this case`);
  }
  return verified ? "verified" : "unverified";
}

function signalsFor(f: RunFinding, label: CaseLabel): Signals {
  const text = `${f.claim}\n${f.path}\n${f.evidence}`;
  const file = normalisePath(f.file);
  const roles = label.acceptedLocations.filter((l) => normalisePath(l.file) === file && f.line >= l.lineRange.start && f.line <= l.lineRange.end).map((l) => l.locationRole);
  const flags = label.rootCause?.regexFlags ?? "i";
  const concepts = (label.rootCause?.requiredConceptRegexes ?? []).map((r) => new RegExp(r, flags));
  const consumers = label.acceptedLocations.filter((l) => l.locationRole === "unchanged_consumer" && l.symbol !== undefined).map((l) => (l.symbol ?? "").split(".").pop() ?? "");
  return {
    locationRoles: [...new Set(roles)].sort(),
    conceptsMatched: concepts.filter((c) => c.test(text)).length,
    conceptsRequired: concepts.length,
    namesConsumer: consumers.some((name) => name !== "" && new RegExp(`\\b${name}\\b`, "i").test(text)),
    uncreditedClaims: (label.rootCause?.uncreditedClaims ?? []).filter((r) => new RegExp(r, "i").test(text)),
  };
}

function isCandidate(s: Signals): boolean {
  return s.locationRoles.length > 0 || (s.conceptsRequired > 0 && s.conceptsMatched === s.conceptsRequired);
}

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

export function scoreRun(input: ScoreInput): ScoreResult {
  const { labels, run, caseId } = input;
  const label: CaseLabel | null = caseId === null ? null : (labels.labels.cases[caseId] ?? null);
  if (caseId !== null && label === null) throw new EvalInputError(`unknown case ${caseId}`);
  const provenance = label ? checkProvenance(run, labels, label) : "unverified";
  const activeLabel = run.status === "complete" ? label : null; // an incomplete run is never scored for detection
  const clean = activeLabel !== null && !activeLabel.expectedRegression;
  const allowed = label?.warningOrCriticalRegressionsAllowed ?? 0;

  const used = new Set<number>();
  const unused: { findingIndex: number; reason: string }[] = [];
  const mine = input.adjudications.filter((a) => a.caseId === caseId && a.runId === run.runId);

  const findings: FindingRecord[] = run.findings.map((f, index) => {
    const fp = fingerprint(f);
    const recheck = input.recheck?.[index] ?? null;
    const base = { index, fingerprint: fp, file: normalisePath(f.file), line: f.line, severity: f.severity, citationRecheck: recheck };
    if (activeLabel === null) return { ...base, class: "unscored", verdict: "unscored", adjudicated: false, signals: null };
    const signals = signalsFor(f, activeLabel);
    const klass: FindingClass = activeLabel.expectedRegression && isCandidate(signals) ? "candidate" : "unlabeled";
    const allowedVerdicts = klass === "candidate" ? CANDIDATE_VERDICTS : UNLABELED_VERDICTS;
    const given = mine.find((a) => a.findingIndex === index);
    if (given) {
      if (given.fingerprint !== fp) unused.push({ findingIndex: index, reason: "fingerprint_mismatch" });
      else if (!allowedVerdicts.has(given.verdict)) unused.push({ findingIndex: index, reason: `verdict_not_allowed_for_${klass}` });
      else { used.add(index); return { ...base, class: klass, verdict: given.verdict, adjudicated: true, signals }; }
    }
    // The documented policy decides what a finding is worth with no human decision. Suggestions are reported separately.
    // In a clean case no warning or critical finding is allowed; in a case with a regression, anything that is not a
    // candidate is not scored until someone decides (the label scores only the introduced regression).
    const verdict: FindingVerdict = f.severity === "suggestion" ? (klass === "candidate" ? "pending" : "suggestion") : klass === "unlabeled" && !activeLabel.expectedRegression ? "false_positive" : "pending";
    return { ...base, class: klass, verdict, adjudicated: false, signals };
  });

  for (const a of mine) {
    if (!used.has(a.findingIndex) && !unused.some((u) => u.findingIndex === a.findingIndex)) unused.push({ findingIndex: a.findingIndex, reason: activeLabel !== null ? "no_such_finding" : "run_not_scored" });
  }

  const candidates = findings.filter((f) => f.class === "candidate");
  const fpCount = findings.filter((f) => f.severity !== "suggestion" && (f.verdict === "false_positive" || (f.class === "candidate" && f.verdict === "incorrect"))).length;
  const fpPending = findings.filter((f) => f.class === "unlabeled" && f.verdict === "pending").length;

  // Skipped on the trusted side without a model call: still a miss on a buggy case, but no evidence on a clean one.
  const skipped = run.status === "complete" && run.reason === "nothing_to_review";
  let detection: Detection;
  let note: string | null = label && skipped ? "nothing_to_review" : null;
  if (!label) { detection = "not_scored"; note = "unlabeled"; }
  else if (run.status === "incomplete") { detection = "not_scored"; note = "incomplete"; }
  else if (clean) detection = "not_applicable";
  else if (candidates.some((c) => c.verdict === "correct")) detection = "hit";
  else if (candidates.some((c) => c.verdict === "pending")) detection = "pending_review";
  else if (candidates.some((c) => c.verdict === "partial")) detection = "partial";
  else detection = "missed";

  const cleanControl: CleanControl = !label || label.expectedRegression ? "not_applicable" : run.status === "incomplete" || skipped ? "not_scored" : fpCount <= allowed ? "clean_pass" : "false_positive";

  const { kept, dropped } = { kept: run.citationKept, dropped: run.citationDropped };
  const total = dropped === null ? null : kept + dropped;
  const { tokensIn, tokensOut } = run.metrics;
  const cost = input.prices && tokensIn !== null && tokensOut !== null ? round((tokensIn * input.prices.inPerMillion + tokensOut * input.prices.outPerMillion) / 1_000_000, 6) : null;

  return {
    schemaVersion: 1,
    runId: run.runId,
    source: run.source,
    caseId,
    labels: { sha256: labels.sha256, benchmark: labels.labels.benchmark },
    provenance,
    completion: { status: run.status, reason: run.reason },
    detection,
    detectionNote: note,
    cleanControl,
    falsePositives: { count: fpCount, pendingReview: fpPending },
    suggestions: findings.filter((f) => f.severity === "suggestion").length,
    final: !findings.some((f) => f.verdict === "pending"),
    citation: {
      kept,
      dropped,
      validity: total === null || total === 0 ? null : round(kept / total, 4),
      recheck: input.recheck === null ? null : { checked: input.recheck.length, valid: input.recheck.filter(Boolean).length },
    },
    metrics: run.metrics,
    estimatedCostUsd: cost,
    findings,
    unusedAdjudications: unused.sort((a, b) => a.findingIndex - b.findingIndex),
  };
}
