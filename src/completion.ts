import type { ParsedReviewerOutput } from "./findings/schema.js";
import type { Completion } from "./types.js";

export interface ReviewerOutcome {
  readonly reviewer: string;
  /** The tier's agents and the coordinator are required. */
  readonly required: boolean;
  /** The reviewer ran to the end (after retries and fallback). False for a crash, timeout or exhausted rate limit. */
  readonly executed: boolean;
  /** The parse of its output, when it produced any. */
  readonly parsed?: ParsedReviewerOutput;
  /** The investigation hit its step limit, so what it found (or did not find) is not a full review. */
  readonly truncated?: boolean;
}

export interface CompletionAssessment {
  readonly completion: Completion;
  /** Why the review is incomplete. Fixed codes plus reviewer ids; empty when complete. */
  readonly reasons: readonly string[];
  /** Problems that do not make the review incomplete but must be shown, e.g. findings dropped as invalid. */
  readonly degraded: readonly string[];
}

/**
 * Decides whether a review is complete. A required reviewer that did not run, produced nothing, or produced output
 * that could not be parsed makes the review incomplete: zero findings from a parser error is NOT a clean review.
 * Only an explicit, error-free empty list counts as "no findings". `blockers` carries failures from earlier stages,
 * such as workspace preparation or sanitisation, each of which also makes the review incomplete.
 */
export function assessCompletion(outcomes: readonly ReviewerOutcome[], blockers: readonly string[] = []): CompletionAssessment {
  const reasons = blockers.map((b) => `blocked: ${b}`);
  const degraded: string[] = [];
  if (!outcomes.some((o) => o.required)) reasons.push("no_required_reviewers");

  for (const outcome of outcomes) {
    const problem = problemWith(outcome);
    if (problem.fatal) (outcome.required ? reasons : degraded).push(`${outcome.reviewer}: ${problem.fatal}`);
    if (problem.partial) degraded.push(`${outcome.reviewer}: ${problem.partial}`);
  }

  return Object.freeze({
    completion: reasons.length === 0 ? ("complete" as const) : ("incomplete" as const),
    reasons: Object.freeze(reasons),
    degraded: Object.freeze(degraded),
  });
}

function problemWith(outcome: ReviewerOutcome): { fatal?: string; partial?: string } {
  if (!outcome.executed) return { fatal: "reviewer_did_not_complete" };
  const parsed = outcome.parsed;
  if (parsed === undefined) return { fatal: "no_output" };
  if (parsed.error !== undefined && parsed.findings.length === 0) return { fatal: `unusable_output (${parsed.error})` };
  if (outcome.truncated === true) return { fatal: "investigation_truncated (step limit reached)" };
  if (parsed.rejected !== undefined && parsed.rejected.length > 0) {
    return { partial: `${parsed.rejected.length} finding(s) dropped as invalid` };
  }
  return {};
}
