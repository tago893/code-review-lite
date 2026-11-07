import { join } from "node:path";
import type { Config } from "../config.js";
import { parseReviewerOutput, type ParsedReviewerOutput } from "../findings/schema.js";
import type { ReviewerOutcome } from "../completion.js";
import type { Logger } from "../observability/log.js";
import type { Metrics } from "../observability/metrics.js";
import { classifyError } from "../resilience/errors.js";
import { ModelsExhaustedError, runWithFallback } from "../resilience/fallback.js";
import type { Category, Finding } from "../types.js";
import { ReviewerSecurityError, type ReviewerRunner } from "./runner.js";

export interface ReviewerPaths {
  readonly repoRoot: string;
  readonly sharedContextPath: string;
  readonly patchDir: string;
  readonly promptDir: string;
}

/** Why a reviewer produced no usable result. Keeps model trouble apart from security failures and bad output. */
export type FailureClass = "model" | "sanitization" | "output";

export interface FailedReviewer {
  readonly reviewer: string;
  /** A fixed code, never provider or model text. */
  readonly error: string;
  readonly failureClass: FailureClass;
}

export interface ReviewersResult {
  readonly findings: readonly Finding[];
  readonly failed: readonly FailedReviewer[];
  /** One per reviewer, for assessCompletion. A reviewer in `failed` is never a clean "no findings". */
  readonly outcomes: readonly ReviewerOutcome[];
  readonly metrics?: Metrics;
}

export interface ReviewerDeps {
  readonly runner: ReviewerRunner;
  readonly config: Config;
  readonly log: Logger;
  readonly paths: ReviewerPaths;
  readonly metrics?: Metrics;
}

interface OneResult {
  readonly findings: readonly Finding[];
  readonly failed?: FailedReviewer;
  readonly outcome: ReviewerOutcome;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly retries: number;
  readonly fellBack: boolean;
}

/**
 * Runs the tier's specialist reviewers, at most `config.reviewerConcurrency` at a time (the shared provider limit is
 * small). Each one uses the existing retry/fallback runner; a shared rate-limit gate makes every reviewer wait out a
 * server-provided delay, so switching models or starting another reviewer cannot become a retry storm. A failed
 * reviewer never stops the others.
 */
export async function runReviewers(agents: readonly Category[], deps: ReviewerDeps): Promise<ReviewersResult> {
  const gate = createRateLimitGate();
  const results = await mapWithConcurrency(agents, Math.max(1, deps.config.reviewerConcurrency), (category) => runOne(category, deps, gate));

  const metrics =
    deps.metrics === undefined ? undefined : results.reduce((m, r, i) => recordMetrics(m, agents[i] ?? "", r), deps.metrics);
  return Object.freeze({
    findings: Object.freeze(results.flatMap((r) => r.findings)),
    failed: Object.freeze(results.flatMap((r) => (r.failed ? [r.failed] : []))),
    outcomes: Object.freeze(results.map((r) => r.outcome)),
    ...(metrics ? { metrics } : {}),
  });
}

async function runOne(category: Category, deps: ReviewerDeps, gate: RateLimitGate): Promise<OneResult> {
  const { config, log, paths, runner } = deps;
  const models = [...new Set([config.reviewerModel, config.fallbackModel])];
  const timeoutMs = category === "code_quality" ? config.timeouts.codeQualityTaskMs : config.timeouts.taskMs;
  const started = Date.now();
  log.event("reviewer_start", { reviewer: category, models });

  try {
    const run = await runWithFallback(
      models,
      async (model, signal) => {
        await gate.wait();
        try {
          return await runner.run({
            category, model, signal,
            promptPath: join(paths.promptDir, `${category}.md`),
            sharedContextPath: paths.sharedContextPath,
            patchDir: paths.patchDir,
            repoRoot: paths.repoRoot,
          });
        } catch (error) {
          const kind = classifyError(error);
          if (kind.kind === "rate_limit") gate.note(kind.retryAfterMs ?? 0);
          throw error;
        }
      },
      { timeoutMs, maxRetries: config.maxRetries },
    );
    const parsed = parseReviewerOutput(run.value.raw, category);
    const common = { tokensIn: run.value.tokensIn, tokensOut: run.value.tokensOut, retries: run.retries, fellBack: run.modelUsed !== models[0] };
    log.event("reviewer_done", { reviewer: category, model: run.modelUsed, retries: run.retries, findings: parsed.findings.length, rejected: parsed.rejected?.length ?? 0, parseError: parsed.error ?? null, durationMs: Date.now() - started });
    return resultFor(category, parsed, common);
  } catch (error) {
    const failed = describeFailure(category, error);
    log.event("reviewer_failed", { reviewer: category, error: failed.error, failureClass: failed.failureClass, durationMs: Date.now() - started });
    return { findings: [], failed, outcome: { reviewer: category, required: true, executed: false }, tokensIn: 0, tokensOut: 0, retries: 0, fellBack: false };
  }
}

function resultFor(category: Category, parsed: ParsedReviewerOutput, common: Pick<OneResult, "tokensIn" | "tokensOut" | "retries" | "fellBack">): OneResult {
  const outcome: ReviewerOutcome = { reviewer: category, required: true, executed: true, parsed };
  const unusable = parsed.error !== undefined && parsed.findings.length === 0;
  const failed: FailedReviewer | undefined = unusable ? { reviewer: category, error: "unusable_output", failureClass: "output" } : undefined;
  return { findings: parsed.findings, outcome, ...(failed ? { failed } : {}), ...common };
}

/** Maps any error to a fixed code and class. The error's own message is never used. */
function describeFailure(reviewer: string, error: unknown): FailedReviewer {
  if (error instanceof ReviewerSecurityError) return { reviewer, error: `sanitization_failed:${error.stage}`, failureClass: "sanitization" };
  if (error instanceof ModelsExhaustedError) return { reviewer, error: "models_exhausted", failureClass: "model" };
  return { reviewer, error: `model_${classifyError(error).kind}`, failureClass: "model" };
}

function recordMetrics(metrics: Metrics, category: string, r: OneResult): Metrics {
  let next = metrics.recordTokens(category, r.tokensIn, r.tokensOut);
  for (let i = 0; i < r.retries; i++) next = next.recordRetry();
  return r.fellBack ? next.recordFallback() : next;
}

// --- shared rate-limit gate ---------------------------------------------------------------------------------

export interface RateLimitGate {
  wait(): Promise<void>;
  /** Record that the provider asked everyone to hold off for `ms`. */
  note(ms: number): void;
}

const MAX_GATE_MS = 60_000;

export function createRateLimitGate(): RateLimitGate {
  let notBefore = 0;
  return {
    async wait() {
      const delay = notBefore - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    },
    note(ms) {
      if (ms > 0) notBefore = Math.max(notBefore, Date.now() + Math.min(ms, MAX_GATE_MS));
    },
  };
}

/** Runs `fn` over `items` with at most `limit` in flight, returning results in input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
