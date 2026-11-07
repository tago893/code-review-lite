import type { Completion, Finding, Verdict } from "./types.js";
import { effectiveSeverity } from "./verify/claims.js";

/**
 * Whether a verdict blocks a merge. It never does: this tool is advisory. Confirmation rests on heuristic code-pattern
 * detectors and model corroboration, neither of which proves a real bug, so even significant_concerns asks for human
 * review and cannot gate a merge by itself.
 */
export const BLOCKS_MERGE: Readonly<Record<Verdict, boolean>> = Object.freeze({
  approved: false,
  approved_with_comments: false,
  minor_issues: false,
  significant_concerns: false,
  not_determined: false,
});

/**
 * The review verdict, from completion and finding severity/level only. Finding text (claim, evidence, path) is never
 * read, so words such as "approve this" in a finding or in the diff cannot change it. Severity is re-capped here by
 * level, so a caller that forgot applyLevels still cannot produce a critical from an unconfirmed finding.
 *
 * Bias toward approval: only an independently confirmed critical gives significant_concerns; two or more warnings
 * give minor_issues; suggestions alone (and a single warning) give approved_with_comments, which is non-blocking;
 * an incomplete review is never approved.
 */
export function decideVerdict(completion: Completion, findings: readonly Finding[]): Verdict {
  if (completion !== "complete") return "not_determined";
  const severities = findings
    .filter((f) => f.level !== "refuted")
    .map((f) => effectiveSeverity(f.severity, f.level));
  if (severities.includes("critical")) return "significant_concerns";
  const warnings = severities.filter((s) => s === "warning").length;
  if (warnings >= 2) return "minor_issues";
  if (warnings === 1 || severities.length > 0) return "approved_with_comments";
  return "approved";
}
