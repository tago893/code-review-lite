import { join } from "node:path";
import type { Config } from "../config.js";
import { parseReviewerOutput, type ParsedReviewerOutput } from "../findings/schema.js";
import type { ReviewerOutcome } from "../completion.js";
import type { Logger } from "../observability/log.js";
import type { Metrics } from "../observability/metrics.js";
import { classifyError } from "../resilience/errors.js";
import { ModelsExhaustedError, runWithFallback, type AttemptEvent } from "../resilience/fallback.js";
import type { KnownUsage } from "./scrub.js";
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
  /** Everything this reviewer spent, including attempts that failed. */
  readonly tally: Tally;
}

/** Token usage and retry accounting for one reviewer across all of its attempts. Immutable: each step returns a new one. */
interface Tally {
  readonly input: number;
  readonly output: number;
  /** False when some of the usage is from work that was cut short, so the figures are a lower bound. */
  readonly complete: boolean;
  /** Attempts that used the provider but reported no usage: unknown, not zero. */
  readonly unreported: number;
  readonly retries: number;
  readonly fellBack: boolean;
}

const EMPTY_TALLY: Tally = Object.freeze({ input: 0, output: 0, complete: true, unreported: 0, retries: 0, fellBack: false });

function tallyFailure(t: Tally, usage: KnownUsage | undefined, retried: boolean, fellBack: boolean): Tally {
  return {
    ...t,
    input: t.input + (usage?.input ?? 0), output: t.output + (usage?.output ?? 0),
    complete: usage === undefined ? t.complete : t.complete && usage.complete, // silent attempts are counted in unreported
    unreported: t.unreported + (usage === undefined ? 1 : 0),
    retries: t.retries + (retried ? 1 : 0),
    fellBack: t.fellBack || fellBack,
  };
}

function tallySuccess(t: Tally, result: { tokensIn: number; tokensOut: number; tokensKnown?: boolean }): Tally {
  return result.tokensKnown === false
    ? { ...t, unreported: t.unreported + 1 }
    : { ...t, input: t.input + result.tokensIn, output: t.output + result.tokensOut };
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

  let tally = EMPTY_TALLY;
  let attemptNo = 0;
  let attemptId = "";
  const onEvent = (event: AttemptEvent): void => {
    if (event.type === "start") {
      attemptId = `${category}#${++attemptNo}`;
      log.event("attempt_start", { reviewer: category, attemptId, model: event.model, tryNo: event.tryNo });
    } else if (event.type === "succeeded") {
      log.event("attempt_succeeded", { reviewer: category, attemptId, model: event.model, tryNo: event.tryNo });
    } else {
      const { type: _type, ...detail } = event;
      log.event("attempt_failed", { reviewer: category, attemptId, ...detail });
      tally = tallyFailure(tally, event.usage, event.decision !== "stop_not_retryable", event.model !== models[0]);
    }
  };

  try {
    const run = await runWithFallback(
      models,
      async (model, signal) => {
        await gate.wait();
        try {
          return await runner.run({
            category, model, signal, attemptId,
            promptPath: join(paths.promptDir, `${category}.md`),
            sharedContextPath: paths.sharedContextPath,
            patchDir: paths.patchDir,
            repoRoot: paths.repoRoot,
          });
        } catch (error) {
          const kind = classifyError(error);
          if (kind.kind === "rate_limit") gate.note(kind.retryAfterMs ?? 0);
          // Refusing unsafe input happens before any model is contacted: that is a known zero, not an unknown.
          throw error instanceof ReviewerSecurityError ? Object.assign(error, { usage: { input: 0, output: 0, complete: true } }) : error;
        }
      },
      { timeoutMs, maxRetries: config.maxRetries, abortGraceMs: config.timeouts.abortGraceMs, onEvent },
    );
    tally = { ...tallySuccess(tally, run.value), fellBack: run.modelUsed !== models[0] };
    const parsed = parseReviewerOutput(run.value.raw, category);
    log.event("reviewer_done", { reviewer: category, model: run.modelUsed, retries: run.retries, findings: parsed.findings.length, rejected: parsed.rejected?.length ?? 0, parseError: parsed.error ?? null, truncated: run.value.truncated === true, durationMs: Date.now() - started });
    return resultFor(category, parsed, tally, run.value.truncated === true);
  } catch (error) {
    const failed = describeFailure(category, error);
    log.event("reviewer_failed", { reviewer: category, error: failed.error, failureClass: failed.failureClass, ...failureDetail(error), durationMs: Date.now() - started });
    return { findings: [], failed, outcome: { reviewer: category, required: true, executed: false }, tally };
  }
}

function resultFor(category: Category, parsed: ParsedReviewerOutput, tally: Tally, truncated: boolean): OneResult {
  const outcome: ReviewerOutcome = { reviewer: category, required: true, executed: true, parsed, ...(truncated ? { truncated } : {}) };
  const unusable = parsed.error !== undefined && parsed.findings.length === 0;
  const failed: FailedReviewer | undefined = unusable ? { reviewer: category, error: "unusable_output", failureClass: "output" } : undefined;
  return { findings: parsed.findings, outcome, ...(failed ? { failed } : {}), tally };
}

/** Fixed-vocabulary detail for the log: error kinds per attempt, or the SDK error name. Never message text. */
function failureDetail(error: unknown): Record<string, unknown> {
  if (error instanceof ModelsExhaustedError) return { attempts: error.attempts };
  const sdkName = (error as { sdkName?: unknown } | null)?.sdkName;
  return { kind: classifyError(error).kind, ...(typeof sdkName === "string" ? { sdkName } : {}) };
}

/** Maps any error to a fixed code and class. The error's own message is never used. */
function describeFailure(reviewer: string, error: unknown): FailedReviewer {
  if (error instanceof ReviewerSecurityError) return { reviewer, error: `sanitization_failed:${error.stage}`, failureClass: "sanitization" };
  if (error instanceof ModelsExhaustedError) return { reviewer, error: "models_exhausted", failureClass: "model" };
  return { reviewer, error: `model_${classifyError(error).kind}`, failureClass: "model" };
}

function recordMetrics(metrics: Metrics, category: string, r: OneResult): Metrics {
  const t = r.tally;
  let next = t.input + t.output > 0 || !t.complete ? metrics.recordTokens(category, t.input, t.output, t.complete) : metrics;
  for (let i = 0; i < t.unreported; i++) next = next.recordUnreportedTokens(category);
  for (let i = 0; i < t.retries; i++) next = next.recordRetry();
  return t.fellBack ? next.recordFallback() : next;
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
