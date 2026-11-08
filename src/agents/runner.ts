import type { Category } from "../types.js";

export interface ReviewerRequest {
  readonly category: Category;
  readonly model: string;
  /** The category prompt. REVIEWER_SHARED.md is read from the same directory. */
  readonly promptPath: string;
  /** Pre-written, sanitised diff context under /review/context. */
  readonly sharedContextPath: string;
  /** Directory of per-file patches under /review/context, which the agent may read. */
  readonly patchDir: string;
  /** The sanitised, read-only snapshot the agent works in. */
  readonly repoRoot: string;
  /** Aborted when the attempt times out. */
  readonly signal?: AbortSignal;
  /** Identifies this attempt in logs, e.g. "code_quality#2". */
  readonly attemptId?: string;
}

export interface RunnerResult {
  /** The Phase 2 structured output, as text for parseReviewerOutput. */
  readonly raw: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** False when the provider reported no usage, so the counts above are not real zeros. */
  readonly tokensKnown?: boolean;
  /**
   * The Phase 1 investigation used its whole step allowance. Its notes may be incomplete, so even an empty result must
   * not be treated as a clean review.
   */
  readonly truncated?: boolean;
}

export interface ReviewerRunner {
  run(req: ReviewerRequest): Promise<RunnerResult>;
}

export type SecurityStage = "phase1_context" | "phase2_notes";

/**
 * Raised when text could not be sanitised for a model. It is distinct from a model failure and from a review with
 * no findings, and it is non-retryable: retrying or switching models cannot make unsafe input safe.
 */
export class ReviewerSecurityError extends Error {
  readonly code = "sanitization_failed";
  readonly stage: SecurityStage;

  constructor(stage: SecurityStage, reason: string) {
    super(`sanitization_failed at ${stage}: ${reason}`);
    this.name = "ReviewerSecurityError";
    this.stage = stage;
  }
}
