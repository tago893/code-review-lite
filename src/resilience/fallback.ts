import { usageOf, type KnownUsage } from "../agents/scrub.js";
import { classifyError, type ErrorKind } from "./errors.js";

export type RetryDecision = "retry_same_model" | "fallback_model" | "exhausted" | "stop_not_retryable";

/** What happened to one attempt. Kinds, decisions and numbers only: never an error message. */
export type AttemptEvent =
  | { readonly type: "start"; readonly model: string; readonly tryNo: number }
  | { readonly type: "succeeded"; readonly model: string; readonly tryNo: number }
  | {
      readonly type: "failed";
      readonly model: string;
      readonly tryNo: number;
      readonly kind: ErrorKind;
      readonly decision: RetryDecision;
      readonly delayMs?: number;
      readonly usage?: KnownUsage;
    };

export interface FallbackOptions {
  /** Time allowed for a single attempt. */
  readonly timeoutMs: number;
  /** Retries per model before moving to the next. Default 1. */
  readonly maxRetries?: number;
  /** Longest wait honoured between attempts, even if the server asks for more. Default 30 000. */
  readonly maxDelayMs?: number;
  /** Wait when the server gave no delay. Default 1000, doubled per retry. */
  readonly baseDelayMs?: number;
  /**
   * How long a timed-out attempt is given to clean up after its signal is aborted (for example to cancel an OpenCode
   * session) before the run stops waiting for it. Default 15 000.
   */
  readonly abortGraceMs?: number;
  /** Called for every attempt start, success and failure, so retry and fallback decisions can be logged. */
  readonly onEvent?: (event: AttemptEvent) => void;
}

export interface FallbackResult<T> {
  readonly value: T;
  readonly modelUsed: string;
  /** Number of attempts that failed retryably before this one succeeded. */
  readonly retries: number;
}

export interface FailedAttempt {
  readonly model: string;
  readonly kind: ErrorKind;
  /** Tokens the attempt is known to have used, when it reported any. A lower bound if `complete` is false. */
  readonly usage?: KnownUsage;
}

/** Every model failed with a retryable error. Carries error kinds only, never their messages. */
export class ModelsExhaustedError extends Error {
  readonly attempts: readonly FailedAttempt[];

  constructor(attempts: readonly FailedAttempt[]) {
    super(`all models failed after ${attempts.length} attempts`);
    this.name = "ModelsExhaustedError";
    this.attempts = Object.freeze([...attempts]);
  }
}

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_ABORT_GRACE_MS = 15_000;

/**
 * Runs `attempt` on the first model, retrying retryable failures (rate limit, server error, transport error) up to
 * maxRetries times and honouring the server's retry delay, then moves to the next model. A non-retryable error (auth,
 * context overflow, abort, unknown) is thrown at once with no retry and no fallback; a timeout is such an error. When
 * every model is exhausted it throws ModelsExhaustedError, which the caller must turn into an incomplete review.
 *
 * An attempt is never abandoned while still running: on timeout its signal is aborted and the run waits (up to
 * abortGraceMs) for the attempt to finish cleaning up before it rejects, so a replacement cannot overlap it.
 */
export async function runWithFallback<T>(
  models: readonly string[],
  attempt: (model: string, signal: AbortSignal) => Promise<T>,
  opts: FallbackOptions,
): Promise<FallbackResult<T>> {
  if (models.length === 0) throw new Error("runWithFallback needs at least one model");
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const emit = (event: AttemptEvent): void => {
    try { opts.onEvent?.(event); } catch { /* observability must never break a review */ }
  };
  const failures: FailedAttempt[] = [];

  for (const model of models) {
    for (let tryNo = 0; tryNo <= maxRetries; tryNo++) {
      emit({ type: "start", model, tryNo });
      try {
        const value = await withTimeout((signal) => attempt(model, signal), opts.timeoutMs, opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
        emit({ type: "succeeded", model, tryNo });
        return Object.freeze({ value, modelUsed: model, retries: failures.length });
      } catch (error) {
        const kind = classifyError(error);
        const usage = usageOf(error);
        if (!kind.retryable) {
          emit({ type: "failed", model, tryNo, kind: kind.kind, decision: "stop_not_retryable", ...(usage ? { usage } : {}) });
          throw error;
        }
        failures.push({ model, kind: kind.kind, ...(usage ? { usage } : {}) });
        const isLastModel = model === models[models.length - 1];
        const hasMoreTries = tryNo < maxRetries || !isLastModel;
        const decision: RetryDecision = !hasMoreTries ? "exhausted" : tryNo < maxRetries ? "retry_same_model" : "fallback_model";
        const delayMs = hasMoreTries ? delayFor(kind.retryAfterMs, tryNo, opts) : undefined;
        emit({ type: "failed", model, tryNo, kind: kind.kind, decision, ...(delayMs === undefined ? {} : { delayMs }), ...(usage ? { usage } : {}) });
        if (delayMs !== undefined) await sleep(delayMs);
      }
    }
  }
  throw new ModelsExhaustedError(failures);
}

function delayFor(serverMs: number | undefined, tryNo: number, opts: FallbackOptions): number {
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const fallback = (opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS) * 2 ** tryNo;
  return Math.min(serverMs ?? fallback, cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, graceMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let deadline: (Error & { usage?: unknown }) | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      deadline = Object.assign(new Error("attempt timed out"), { name: "TimeoutError" });
      controller.abort(deadline);
      // The attempt owns whatever it started (an OpenCode session). Give it the chance to cancel and clean up.
      graceTimer = setTimeout(() => reject(deadline), graceMs);
    }, timeoutMs);

    const finish = (): void => { clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); };
    run(controller.signal).then(
      (value) => {
        finish();
        if (deadline) reject(deadline); // finished only after the deadline: not a success
        else resolve(value);
      },
      (error: unknown) => {
        finish();
        if (!deadline) return reject(error);
        const usage = usageOf(error);
        reject(usage ? Object.assign(deadline, { usage }) : deadline);
      },
    );
  });
}
