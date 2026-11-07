import { classifyError, type ErrorKind } from "./errors.js";

export interface FallbackOptions {
  /** Time allowed for a single attempt. */
  readonly timeoutMs: number;
  /** Retries per model before moving to the next. Default 1. */
  readonly maxRetries?: number;
  /** Longest wait honoured between attempts, even if the server asks for more. Default 30 000. */
  readonly maxDelayMs?: number;
  /** Wait when the server gave no delay. Default 1000, doubled per retry. */
  readonly baseDelayMs?: number;
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

/**
 * Runs `attempt` on the first model, retrying retryable failures (rate limit, server error) up to maxRetries times
 * and honouring the server's retry delay, then moves to the next model. A non-retryable error (auth, context
 * overflow, abort, unknown) is thrown at once with no retry and no fallback; a timeout is such an error. When every
 * model is exhausted it throws ModelsExhaustedError, which the caller must turn into an incomplete review.
 */
export async function runWithFallback<T>(
  models: readonly string[],
  attempt: (model: string, signal: AbortSignal) => Promise<T>,
  opts: FallbackOptions,
): Promise<FallbackResult<T>> {
  if (models.length === 0) throw new Error("runWithFallback needs at least one model");
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const failures: FailedAttempt[] = [];

  for (const model of models) {
    for (let tryNo = 0; tryNo <= maxRetries; tryNo++) {
      try {
        const value = await withTimeout((signal) => attempt(model, signal), opts.timeoutMs);
        return Object.freeze({ value, modelUsed: model, retries: failures.length });
      } catch (error) {
        const kind = classifyError(error);
        if (!kind.retryable) throw error;
        failures.push({ model, kind: kind.kind });
        const hasMoreTries = tryNo < maxRetries || model !== models[models.length - 1];
        if (hasMoreTries) await sleep(delayFor(kind.retryAfterMs, tryNo, opts));
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

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = Object.assign(new Error("attempt timed out"), { name: "TimeoutError" });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    run(controller.signal).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
