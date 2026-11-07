import type { FailedReviewer } from "../agents/reviewers.js";
import type { MetricsSnapshot } from "../observability/metrics.js";
import type { ExcludedNote } from "../plan.js";
import { redactSecrets } from "../safety/redact.js";
import type { Category, Completion, Tier, Verdict } from "../types.js";
import type { LeveledFinding } from "../verify/claims.js";

export interface ReportData {
  readonly completion: Completion;
  readonly verdict: Verdict;
  /** Why the review is incomplete (fixed codes). */
  readonly reasons: readonly string[];
  /** Problems that do not make the review incomplete but must be shown. */
  readonly degraded: readonly string[];
  readonly findings: readonly LeveledFinding[];
  /** Findings on unchanged lines with no link to a changed symbol. Shown apart and not counted in the verdict. */
  readonly preexisting: readonly LeveledFinding[];
  /** Changed symbols that an unchanged cited line mentions, by finding id: the change may have broken it. */
  readonly linked: Readonly<Record<string, readonly string[]>>;
  /** Neutral facts about how the review was run (for example, documentation-only changes not model-reviewed). */
  readonly notes: readonly string[];
  /** Coordinator one-sentence traces by finding id. */
  readonly traces: Readonly<Record<string, string>>;
  readonly failedReviewers: readonly FailedReviewer[];
  readonly excluded: readonly ExcludedNote[];
  readonly withheld: readonly string[];
  readonly tier: Tier;
  readonly range: { readonly base: string; readonly head: string };
  readonly metrics: MetricsSnapshot;
}

const CATEGORY_TITLE: Readonly<Record<Category, string>> = {
  security: "Security", performance: "Performance", code_quality: "Code quality",
};
const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  approved: "APPROVED", approved_with_comments: "APPROVED WITH COMMENTS", minor_issues: "MINOR ISSUES",
  significant_concerns: "SIGNIFICANT CONCERNS", not_determined: "NOT DETERMINED",
};
const SEVERITY_ORDER = { critical: 0, warning: 1, suggestion: 2 } as const;
const ADVISORY = "This review is advisory. Findings are model- and heuristic-generated and are not proof of a defect; a human decides.";

/** Renders the final report. Every piece of text, including model-supplied, passes through redactSecrets. */
export function renderReport(r: ReportData): string {
  const lines: string[] = [];
  lines.push(r.completion === "incomplete" ? "# REVIEW INCOMPLETE" : `# Review verdict: ${VERDICT_TEXT[r.verdict]}`);
  lines.push("", `Completion: ${r.completion}`, `Verdict: ${r.verdict}`, `Range: ${r.range.base.slice(0, 12)}..${r.range.head.slice(0, 12)} (tier ${r.tier})`);
  if (r.completion === "incomplete") lines.push("", "The review did not finish, so no verdict was reached. Findings below, if any, are partial.", ...bullets(r.reasons));
  if (r.notes.length > 0) lines.push("", "## Notes", ...bullets(r.notes));
  if (r.degraded.length > 0) lines.push("", "## Degraded", ...bullets(r.degraded));
  if (r.failedReviewers.length > 0) {
    lines.push("", "## Failed reviewers", ...bullets(r.failedReviewers.map((f) => `${f.reviewer}: ${f.error} (${f.failureClass})`)));
  }

  lines.push("", "## Findings", ...(r.findings.length === 0 ? [r.completion === "complete" ? "No findings." : "No findings reported (incomplete review)."] : findingSections(r)));
  if (r.preexisting.length > 0) {
    lines.push("", "## Possibly pre-existing (not counted in the verdict)", "The cited line was not changed and mentions no symbol this change declares or modifies. It may still be related; a reviewer should decide.");
    for (const f of r.preexisting) lines.push(...findingBlock(f, r));
  }
  if (r.excluded.length > 0) lines.push("", "## Not reviewed", ...bullets(r.excluded.map((x) => `${x.path} (${x.kind}: ${x.reason})`)));
  if (r.withheld.length > 0) lines.push("", "## Content withheld (sensitive files)", ...bullets(r.withheld));
  lines.push("", ...metricsSection(r.metrics), "", ADVISORY, "");
  return redactSecrets(lines.join("\n"));
}

function bullets(items: readonly string[]): string[] {
  return items.map((i) => `- ${i}`);
}

function findingSections(r: ReportData): string[] {
  const out: string[] = [];
  for (const category of Object.keys(CATEGORY_TITLE) as Category[]) {
    const group = r.findings
      .filter((f) => f.category === category)
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    if (group.length === 0) continue;
    out.push("", `### ${CATEGORY_TITLE[category]}`);
    for (const f of group) out.push(...findingBlock(f, r));
  }
  return out;
}

function findingBlock(f: LeveledFinding, r: ReportData): string[] {
  const head = `- **${f.severity}** \`${f.file}:${f.line}\` - ${oneLine(f.claim)}`;
  const meta = [`level: ${f.label}`];
  if (f.cappedFrom) meta.push(`reported as ${f.cappedFrom}, capped to ${f.severity}`);
  const linked = r.linked[f.id];
  if (linked && linked.length > 0) meta.push(`unchanged line, but it uses changed symbol(s) ${linked.join(", ")}: possibly broken by this change`);
  const trace = r.traces[f.id];
  return [head, `  - ${meta.join("; ")}`, ...(trace ? [`  - coordinator: ${oneLine(trace)}`] : []), `  - flow: ${oneLine(f.path)}`, ...fence(f.evidence)];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** An indented code block whose fence is longer than any backtick run inside, so evidence cannot break out of it. */
function fence(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const mark = "`".repeat(Math.max(3, longest + 1));
  return [`  ${mark}`, ...text.replace(/\r/g, "").split("\n").map((l) => `  ${l}`), `  ${mark}`];
}

function metricsSection(m: MetricsSnapshot): string[] {
  const count = (o: Readonly<Record<string, number>>): string => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  return [
    "## Metrics",
    `findings: ${m.findings.total} (by severity: ${count(m.findings.bySeverity)}; by level: ${count(m.findings.byStatus)})`,
    `dropped: ${m.drops.total} (${count(m.drops.byReason)})`,
    `tokens: ${m.tokens.input} in / ${m.tokens.output} out`,
    `retries: ${m.retries}; fallbacks: ${m.fallbacks}`,
    `cost: $${m.costUsd.toFixed(4)}${m.durationMs === undefined ? "" : `; duration: ${(m.durationMs / 1000).toFixed(1)}s`}`,
  ];
}
