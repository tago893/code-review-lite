import type { JudgeResult } from "./agents/coordinator.js";
import { runReviewers, type ReviewerPaths } from "./agents/reviewers.js";
import type { ReviewerRunner } from "./agents/runner.js";
import { ReviewerSecurityError } from "./agents/runner.js";
import { assessCompletion } from "./completion.js";
import type { Config } from "./config.js";
import { createMetrics, type Metrics, type MetricsSnapshot } from "./observability/metrics.js";
import { startHeartbeat, type Logger } from "./observability/log.js";
import type { ReviewPlan } from "./plan.js";
import { renderReport, type ReportData } from "./report/render.js";
import { ModelsExhaustedError, runWithFallback } from "./resilience/fallback.js";
import type { Completion, Finding, Verdict } from "./types.js";
import { decideVerdict } from "./verdict.js";
import { verifyCitation } from "./verify/citation.js";
import { applyLevels, detectConfirmation, type ConfirmationBasis, type LeveledFinding } from "./verify/claims.js";
import { changedSymbols, linkedSymbols } from "./verify/relation.js";
import { confirmWithVerifier, type Verifier } from "./verify/confirm.js";

/** What the review stage receives: the trusted-side plan plus where the sanitised snapshot and context live. */
export interface PipelineInput {
  readonly plan: ReviewPlan;
  readonly meta: { readonly baseSha: string; readonly headSha: string };
  readonly paths: ReviewerPaths;
}

export type JudgeFn = (findings: readonly Finding[], model: string, signal: AbortSignal) => Promise<JudgeResult>;

export interface PipelineDeps {
  readonly config: Config;
  readonly log: Logger;
  readonly runner: ReviewerRunner;
  readonly judge: JudgeFn;
  /** Corroborates critical/warning candidates on another model. Never the sole input to a merge decision. */
  readonly verifier: Verifier;
  readonly metrics?: Metrics;
  readonly now?: () => number;
  /** Upper bound on verifier calls, to protect the shared provider limit. */
  readonly maxVerifierCalls?: number;
}

export interface PipelineResult {
  readonly report: string;
  readonly completion: Completion;
  readonly verdict: Verdict;
  readonly metrics: MetricsSnapshot;
  /** 0 for a complete review, 2 for an incomplete one. Findings never change it: the tool is advisory. */
  readonly exitCode: 0 | 2;
}

const DEFAULT_MAX_VERIFIER_CALLS = 6;

/**
 * Review stage: reviewers, completion, citation check, coordinator, independent confirmation, level caps, verdict,
 * report. Empty or noise-only plans short-circuit to a complete "approved" with no model call. A failed required
 * reviewer or coordinator makes the review incomplete (not_determined); that is never reported as a clean review.
 */
export async function runReview(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const stopHeartbeat = startHeartbeat(deps.log, deps.config.timeouts.heartbeatMs);
  try {
    return await execute(input, deps, started, now);
  } finally {
    stopHeartbeat();
  }
}

async function execute(input: PipelineInput, deps: PipelineDeps, started: number, now: () => number): Promise<PipelineResult> {
  const { plan, paths } = input;
  const { config, log } = deps;
  let metrics = deps.metrics ?? createMetrics();
  const timedOut = (): boolean => now() - started > config.timeouts.overallMs;
  const finish = (data: Omit<ReportData, "metrics">, m: Metrics): PipelineResult => {
    const final = m.recordCompletion(data.completion).recordDuration(now() - started).snapshot();
    log.event("review_done", { completion: data.completion, verdict: data.verdict, findings: data.findings.length });
    return Object.freeze({ report: renderReport({ ...data, metrics: final }), completion: data.completion, verdict: data.verdict, metrics: final, exitCode: data.completion === "complete" ? (0 as const) : (2 as const) });
  };
  const base: Omit<ReportData, "metrics" | "completion" | "verdict"> = { reasons: [], degraded: [], findings: [], preexisting: [], linked: {}, notes: [], traces: {}, failedReviewers: [], excluded: plan.excluded, withheld: plan.withheld, tier: plan.tier, range: { base: input.meta.baseSha, head: input.meta.headSha } };

  if (plan.disposition === "manual_review") {
    // Changes exist that no reviewer can analyse: a clean approval would be false, so this is incomplete.
    log.event("review_skipped", { reason: "manual_review_required" });
    return finish({ ...base, completion: "incomplete", verdict: "not_determined", reasons: ["manual_review_required", ...plan.manualReasons] }, metrics);
  }
  if (plan.disposition === "skip_clean") {
    log.event("review_skipped", { reason: "nothing_to_review" });
    return finish({ ...base, completion: "complete", verdict: "approved", notes: plan.entries.length > 0 || plan.excluded.length > 0 ? ["no executable code changed: not model-reviewed"] : [] }, metrics);
  }

  log.event("review_start", { tier: plan.tier, agents: plan.agents });
  const reviewed = await runReviewers(plan.agents, { runner: deps.runner, config, log, paths, metrics });
  metrics = reviewed.metrics ?? metrics;
  const assessment = assessCompletion(reviewed.outcomes);
  const blockers: string[] = [...assessment.reasons];
  const degraded: string[] = [...assessment.degraded, ...(plan.unreviewed.length > 0 ? [`not analysed by any reviewer: ${plan.unreviewed.join(", ")}`] : [])];

  // Level 1: every finding must cite real source in the snapshot. Failures are dropped and counted, never shown.
  const cited: Finding[] = [];
  const unchangedLine = new Set<string>();
  let citationDrops = 0;
  for (const finding of reviewed.findings) {
    const check = await verifyCitation(finding, { repoRoot: paths.repoRoot, entries: plan.entries });
    if (!check.ok) { citationDrops += 1; metrics = metrics.recordDrop("citation"); continue; }
    cited.push({ ...finding, level: "citation_valid" });
    if (!check.touchesChangedLine) unchangedLine.add(finding.id);
  }
  if (citationDrops > 0) degraded.push(`${citationDrops} finding(s) dropped: citation did not match the source`);

  let candidates: readonly Finding[] = cited;
  let traces: Readonly<Record<string, string>> = {};
  if (blockers.length === 0 && cited.length > 0) {
    if (timedOut()) {
      blockers.push("overall_timeout");
    } else {
      try {
        const judged = await runJudge(cited, deps);
        candidates = judged.kept;
        traces = judged.traces;
        metrics = metrics.recordTokens("coordinator", judged.tokensIn, judged.tokensOut);
        for (let i = 0; i < judged.refuted; i++) metrics = metrics.recordDrop("refuted");
        for (let i = 0; i < judged.duplicates; i++) metrics = metrics.recordDrop("judge");
        if (judged.refuted > 0) degraded.push(`${judged.refuted} finding(s) dropped: refuted by the coordinator`);
      } catch (error) {
        blockers.push(coordinatorFailure(error));
        log.event("coordinator_failed", { error: coordinatorFailure(error) });
      }
    }
  }

  let confirmed = new Set<string>();
  let basis = new Map<string, ConfirmationBasis>();
  if (blockers.length === 0) {
    const result = await confirm(candidates, deps, input, timedOut);
    confirmed = result.confirmed;
    basis = result.basis;
    if (result.skipped > 0) degraded.push(`${result.skipped} candidate(s) not independently checked (verifier call limit or deadline)`);
  }

  const outcome = applyLevels(candidates, confirmed, basis);
  const { counted, preexisting, linked } = await splitByCausality(outcome.kept, unchangedLine, input);
  if (outcome.unleveled.length > 0) degraded.push(`${outcome.unleveled.length} finding(s) had no level and were not reported`);
  for (const f of counted) metrics = metrics.recordFinding(f, f.level);
  for (let i = 0; i < outcome.refuted.length; i++) metrics = metrics.recordDrop("refuted");

  const completion: Completion = blockers.length === 0 ? "complete" : "incomplete";
  const verdict = decideVerdict(completion, counted);
  return finish({ ...base, completion, verdict, reasons: blockers, degraded, findings: counted, preexisting, linked, traces, failedReviewers: [...reviewed.failed] }, metrics);
}

async function runJudge(findings: readonly Finding[], deps: PipelineDeps): Promise<JudgeResult> {
  const { config } = deps;
  const models = [...new Set([config.coordinatorModel, config.fallbackModel])];
  const run = await runWithFallback(models, (model, signal) => deps.judge(findings, model, signal), { timeoutMs: config.timeouts.taskMs, maxRetries: config.maxRetries });
  return run.value;
}

/** A fixed code for a coordinator failure. The error's own text is never used. */
function coordinatorFailure(error: unknown): string {
  if (error instanceof ReviewerSecurityError) return `coordinator: sanitization_failed:${error.stage}`;
  if (error instanceof ModelsExhaustedError) return "coordinator: models_exhausted";
  return "coordinator: failed";
}

interface Confirmation {
  readonly confirmed: Set<string>;
  readonly basis: Map<string, ConfirmationBasis>;
  readonly skipped: number;
}

/** Deterministic detector first; then, for critical/warning candidates only, a capped number of verifier calls. */
async function confirm(findings: readonly Finding[], deps: PipelineDeps, input: PipelineInput, timedOut: () => boolean): Promise<Confirmation> {
  const confirmed = new Set<string>();
  const basis = new Map<string, ConfirmationBasis>();
  const limit = deps.maxVerifierCalls ?? DEFAULT_MAX_VERIFIER_CALLS;
  let calls = 0;
  let skipped = 0;
  for (const finding of findings) {
    if (finding.severity === "suggestion") continue;
    if (await detectConfirmation(finding, { repoRoot: input.paths.repoRoot, entries: input.plan.entries })) {
      confirmed.add(finding.id);
      basis.set(finding.id, "detector");
      continue;
    }
    if (calls >= limit || timedOut()) { skipped += 1; continue; }
    calls += 1;
    if (await confirmWithVerifier(finding, deps.verifier, { repoRoot: input.paths.repoRoot })) {
      confirmed.add(finding.id);
      basis.set(finding.id, "verifier");
    }
  }
  return { confirmed, basis, skipped };
}

interface Causality {
  readonly counted: readonly LeveledFinding[];
  readonly preexisting: readonly LeveledFinding[];
  readonly linked: Readonly<Record<string, readonly string[]>>;
}

/**
 * A finding on a line the diff did not touch is not automatically pre-existing: a changed function can break an
 * unchanged caller. It stays counted when its line mentions a symbol this change declares or modifies; otherwise it is
 * reported apart and left out of the verdict, so unrelated old issues are not charged to the PR.
 */
async function splitByCausality(findings: readonly LeveledFinding[], unchangedLine: ReadonlySet<string>, input: PipelineInput): Promise<Causality> {
  const symbols = changedSymbols(input.plan.entries);
  const counted: LeveledFinding[] = [];
  const preexisting: LeveledFinding[] = [];
  const linked: Record<string, readonly string[]> = {};
  for (const f of findings) {
    if (!unchangedLine.has(f.id)) { counted.push(f); continue; }
    const mentioned = await linkedSymbols(input.paths.repoRoot, f.file, f.line, symbols);
    if (mentioned.length > 0) { counted.push(f); linked[f.id] = mentioned; } else preexisting.push(f);
  }
  return { counted, preexisting, linked };
}
