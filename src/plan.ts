import { DiffParseError } from "./diff/errors.js";
import { filterNoise, type ExclusionKind } from "./diff/filter.js";
import { parseUnifiedDiff } from "./diff/parse.js";
import { assessRiskTier } from "./risk/tier.js";
import { redactSecrets } from "./safety/redact.js";
import { sanitizeEntries } from "./safety/diff.js";
import { isSensitivePath } from "./workspace/sensitive.js";
import type { Category, DiffEntry, Tier } from "./types.js";

/** A file left out of the review, with the reason. Text is redacted, so it is safe to store and print. */
export interface ExcludedNote {
  readonly path: string;
  readonly kind: string;
  readonly reason: string;
}

/**
 * Everything decided about a diff on the trusted side: which tier and agents run, the sanitised entries the
 * reviewers may see, and what was left out. It is computed from the RAW diff (so risk signals in withheld files still
 * count) and then carried to the review stage, which never sees the raw diff.
 */
export interface ReviewPlan {
  readonly tier: Tier;
  readonly agents: readonly Category[];
  readonly reasons: readonly string[];
  readonly uncertainties: readonly string[];
  readonly size: { readonly changedLines: number; readonly files: number };
  readonly entries: readonly DiffEntry[];
  readonly excluded: readonly ExcludedNote[];
  /** Sensitive files whose content was withheld (env files, keys). Listed so the reviewer knows they changed. */
  readonly withheld: readonly string[];
  /**
   * What the pipeline must do. "skip_clean": nothing needs a model (no changes, safe-to-omit files only, or
   * documentation only). "manual_review": changes exist that no reviewer can analyse (binary, lockfile, bundled asset,
   * withheld sensitive content), so a clean approval would be false. "review": run the reviewers.
   */
  readonly disposition: Disposition;
  /** Why manual review is required (fixed codes plus redacted paths). Empty unless disposition is "manual_review". */
  readonly manualReasons: readonly string[];
  /** Excluded files that nobody reviewed and that could matter, shown even when other files are reviewed. */
  readonly unreviewed: readonly string[];
}

export type Disposition = "review" | "skip_clean" | "manual_review";

/**
 * Exclusions that are safe to omit: only a pure rename. A "generated" file is excluded from the model's input but is NOT
 * safe to omit: the marker is a comment anyone can write, so a change hidden behind it is listed as unreviewed and can never
 * turn into a clean skip on its own.
 */
const SAFE_TO_OMIT: ReadonlySet<ExclusionKind> = new Set<ExclusionKind>(["rename_only"]);
// .txt is not a documentation extension (requirements.txt and CMakeLists.txt are code), matching src/risk/paths.ts.
const DOC_EXTENSION = /\.(?:md|mdx|rst|adoc)$/i;
// Conventional documentation names, bare or with a documentation extension: LICENSE, README.txt; not src/notice.ts.
const DOC_NAME = /^(?:readme|license|licence|changelog|contributing|notice)(?:\.(?:md|mdx|rst|adoc|txt))?$/i;
// Markdown that coding agents and CI read as instructions or configuration: not documentation, always reviewed.
const AGENT_CONFIG_FILE = /(?:^|\/)(?:agents|claude|gemini|skill)\.md$/i;
const AGENT_CONFIG_DIR = /(?:^|\/)\.(?:github|claude|cursor|windsurf|continue|gemini|codex)\//i;

/** Documentation a model cannot usefully review. Agent instruction files and CI config are not documentation. */
function isDocumentation(path: string): boolean {
  if (AGENT_CONFIG_FILE.test(path) || AGENT_CONFIG_DIR.test(path)) return false;
  const name = path.split("/").pop() ?? path;
  return DOC_EXTENSION.test(name) || DOC_NAME.test(name);
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ReviewPlan }
  | { readonly ok: false; readonly reason: "diff_parse_failed" | "sanitization_failed" };

/** Parse, filter, route and sanitise a raw diff. Deterministic; never throws; the failure reason is a fixed code. */
export function planReview(diffText: string): PlanResult {
  try {
    const { kept, removed } = filterNoise(parseUnifiedDiff(diffText));
    const assessment = assessRiskTier(kept, removed);
    const isSensitive = (e: DiffEntry): boolean => isSensitivePath(e.newPath) || isSensitivePath(e.oldPath);
    const sanitized = sanitizeEntries(kept.filter((e) => !isSensitive(e)));
    if (!sanitized.ok) return { ok: false, reason: "sanitization_failed" };

    const unsafe = removed.filter((r) => !SAFE_TO_OMIT.has(r.kind));
    const unreviewed = unsafe.map((r) => `${redactSecrets(r.path)} (${r.kind})`);
    const withheld = kept.filter(isSensitive).map((e) => redactSecrets(e.newPath));
    const docsOnly = kept.length > 0 && kept.every((e) => isDocumentation(e.newPath));
    const manualReasons = [
      ...(kept.length === 0 || docsOnly ? unreviewed.map((u) => `unanalysed change: ${u}`) : []),
      ...(kept.length > 0 && sanitized.entries.length === 0 && !docsOnly ? withheld.map((w) => `sensitive content withheld: ${w}`) : []),
    ];
    const disposition: Disposition = manualReasons.length > 0 ? "manual_review" : kept.length === 0 || docsOnly ? "skip_clean" : "review";

    return {
      ok: true,
      plan: Object.freeze({
        tier: assessment.tier,
        agents: assessment.agents,
        reasons: Object.freeze(assessment.reasons.map((s) => redactSecrets(s))),
        uncertainties: Object.freeze(assessment.uncertainties.map((s) => redactSecrets(s))),
        size: assessment.size,
        entries: sanitized.entries,
        excluded: Object.freeze(removed.map((r) => Object.freeze({ path: redactSecrets(r.path), kind: r.kind, reason: redactSecrets(r.reason) }))),
        withheld: Object.freeze(withheld),
        disposition,
        manualReasons: Object.freeze(manualReasons),
        unreviewed: Object.freeze(unreviewed),
      }),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof DiffParseError ? "diff_parse_failed" : "sanitization_failed" };
  }
}
