import type { DiffEntry, Finding, FindingLevel, Severity } from "../types.js";
import { readSnapshotLines, verifyCitation } from "./citation.js";
import { queryInLoop, removedAuthCheck, isRouteFile, sqlConcatReachesQuery } from "./detectors.js";

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { suggestion: 0, warning: 1, critical: 2 };

/** The highest severity a finding may carry at each level. Refuted findings are not reported at all. */
const MAX_SEVERITY: Readonly<Record<Exclude<FindingLevel, "refuted">, Severity>> = {
  citation_valid: "suggestion",
  semantically_supported: "warning",
  independently_confirmed: "critical",
};

export const LEVEL_LABEL: Readonly<Record<Exclude<FindingLevel, "refuted">, string>> = {
  citation_valid: "unconfirmed",
  semantically_supported: "model-assessed support (coordinator), not independently confirmed",
  independently_confirmed: "confirmed (basis unspecified); not proof of exploitability",
};

/**
 * Where an `independently_confirmed` level came from. Neither source proves the reported bug is real:
 * a detector confirms that a code pattern is present at the cited place; a verifier's "agrees" is corroboration
 * by another model, not proof.
 */
export type ConfirmationBasis = "detector" | "verifier";

export const BASIS_LABEL: Readonly<Record<ConfirmationBasis, string>> = {
  detector: "code pattern matched by a heuristic detector; not proof of exploitability",
  verifier: "corroborated by a verifier model; model agreement is not proof",
};

/** A finding after caps: severity is the capped value and `cappedFrom` records the reviewer's original. */
export interface LeveledFinding extends Finding {
  readonly level: Exclude<FindingLevel, "refuted">;
  readonly label: string;
  readonly cappedFrom?: Severity;
  /** Present for independently_confirmed findings whose basis was reported. */
  readonly basis?: ConfirmationBasis;
}

export interface LevelOutcome {
  readonly kept: readonly LeveledFinding[];
  /** Findings at level "refuted": dropped, and counted by the caller. */
  readonly refuted: readonly Finding[];
  /** Findings with no level and no confirmation. They were never verified, so they are neither kept nor refuted. */
  readonly unleveled: readonly Finding[];
}

/** Severity after the cap for `level`. A missing level is treated as the lowest, so an unverified critical is never a critical. */
export function effectiveSeverity(severity: Severity, level: FindingLevel | undefined): Severity {
  if (level === undefined || level === "refuted") return "suggestion";
  const max = MAX_SEVERITY[level];
  return SEVERITY_RANK[severity] > SEVERITY_RANK[max] ? max : severity;
}

/**
 * Applies the level caps. `confirmed` holds ids that passed a deterministic detector or a verifier on another model;
 * nothing else can raise a finding to independently_confirmed, so coordinator judgment alone never does.
 * Precondition: findings already carry `citation_valid` or `semantically_supported` from the earlier stages.
 */
export function applyLevels(
  findings: readonly Finding[],
  confirmed: ReadonlySet<string>,
  basisById: ReadonlyMap<string, ConfirmationBasis> = new Map(),
): LevelOutcome {
  const kept: LeveledFinding[] = [];
  const refuted: Finding[] = [];
  const unleveled: Finding[] = [];
  for (const finding of findings) {
    if (finding.level === "refuted") {
      refuted.push(finding);
      continue;
    }
    const level = confirmed.has(finding.id) ? "independently_confirmed" : finding.level;
    if (level === undefined) {
      unleveled.push(finding);
      continue;
    }
    kept.push(leveled(finding, level, level === "independently_confirmed" ? basisById.get(finding.id) : undefined));
  }
  return Object.freeze({ kept: Object.freeze(kept), refuted: Object.freeze(refuted), unleveled: Object.freeze(unleveled) });
}

function leveled(finding: Finding, level: Exclude<FindingLevel, "refuted">, basis: ConfirmationBasis | undefined): LeveledFinding {
  const severity = effectiveSeverity(finding.severity, level);
  const label = basis === undefined ? LEVEL_LABEL[level] : `confirmed: ${BASIS_LABEL[basis]}`;
  const base = { ...finding, level, severity, label, ...(basis === undefined ? {} : { basis }) };
  return Object.freeze(severity === finding.severity ? base : { ...base, cappedFrom: finding.severity });
}

// --- deterministic confirmation -----------------------------------------------------------------------------

export interface ConfirmationContext {
  readonly repoRoot: string;
  readonly entries: readonly DiffEntry[];
}

const SQL_CLAIM = /sql|inject|quer(?:y|ies)|concatenat|interpolat/i;
const AUTH_CLAIM = /auth|permission|access|admin|role|validat|check|guard|bypass/i;
const LOOP_CLAIM = /loop|n\s*\+\s*1|per[- ]?(?:item|row|iteration)|each|repeated|iterat|batch/i;

/**
 * True when a deterministic detector finds a known code PATTERN at the finding's cited location (no model involved).
 * This confirms that the pattern is present, not that it is exploitable or a real behavioral bug: the detectors are
 * regex and indentation heuristics. Report it with BASIS_LABEL.detector and never use it alone to block a merge.
 * The citation must verify against the snapshot first, and the claim must be about the class the detector knows.
 * It never throws; any failure is "not confirmed".
 */
export async function detectConfirmation(finding: Finding, ctx: ConfirmationContext): Promise<boolean> {
  try {
    const citation = await verifyCitation(finding, ctx);
    if (!citation.ok) return false;
    const lines = await readSnapshotLines(ctx.repoRoot, finding.file);
    const entry = ctx.entries.find((e) => e.newPath === finding.file && e.status !== "deleted");

    if (finding.category === "security") {
      if (SQL_CLAIM.test(finding.claim) && citation.touchesChangedLine && sqlConcatReachesQuery(lines, finding.line)) return true;
      return AUTH_CLAIM.test(finding.claim) && entry !== undefined && isRouteFile(finding.file, lines) && removedAuthCheck(entry, finding.line);
    }
    if (finding.category === "performance") {
      return LOOP_CLAIM.test(finding.claim) && citation.touchesChangedLine && queryInLoop(lines, finding.line);
    }
    return false;
  } catch {
    return false;
  }
}
