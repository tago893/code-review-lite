import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

// Everything that reads files for the scorer. It turns three kinds of existing run artifact (lean, legacy, recorded
// demo) into one normalised `Run`, and loads the benchmark labels and the human adjudications. It never writes, never
// calls a model, and never imports the reviewer. A value that is not in the artifact is `null`, never a guess.

export class EvalInputError extends Error {}

const run = promisify(execFile);

// ---- shared shapes ----------------------------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "suggestion";

export interface RunFinding {
  readonly file: string;
  readonly line: number;
  readonly severity: Severity;
  readonly category: string;
  readonly evidence: string;
  readonly claim: string;
  readonly path: string;
}

export interface RunMetrics {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** True when the artifact itself says the token counts are a lower bound (legacy runs with unreported usage). */
  readonly tokensLowerBound: boolean;
  /** Model requests sent by the reviewer, not counting the client's transparent HTTP 429 re-sends. */
  readonly modelRequests: number | null;
  readonly toolCalls: number | null;
  /** Provider retries: 429 waits in a lean trace, session retries in a legacy log. */
  readonly retries: number | null;
  /** Provider failures as `<status>_<code>`, in trace order. */
  readonly providerErrors: readonly string[];
  readonly durationMs: number | null;
}

export interface Run {
  readonly source: "lean" | "legacy" | "demo";
  /** The artifact's folder or file name. Never an absolute path, so results do not depend on where the artifact sits. */
  readonly runId: string;
  readonly status: "complete" | "incomplete";
  /** Why an incomplete run stopped; for a complete run, null, or "nothing_to_review" when it was skipped without a model call. */
  readonly reason: string | null;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly findings: readonly RunFinding[];
  /** Findings the reviewer's own citation check kept, and rejected (null when the artifact does not say). */
  readonly citationKept: number;
  readonly citationDropped: number | null;
  readonly metrics: RunMetrics;
}

const severity = z.enum(["critical", "warning", "suggestion"]);
const findingSchema = z.object({
  severity,
  category: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  evidence: z.string(),
  claim: z.string(),
  path: z.string(),
});

const count = z.number().finite().nonnegative();

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { throw new EvalInputError(`cannot read ${basename(path)}`); }
}

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try { raw = JSON.parse(readText(path)); } catch (error) {
    if (error instanceof EvalInputError) throw error;
    throw new EvalInputError(`${basename(path)} is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new EvalInputError(`${basename(path)} does not match the expected shape: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** Content hash that does not change when git converts line endings. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

// ---- labels -----------------------------------------------------------------------------------------------------

const locationSchema = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  lineRange: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }),
  locationRole: z.string(),
});

const caseSchema = z.object({
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  expectedRegression: z.boolean(),
  acceptedLocations: z.array(locationSchema),
  rootCause: z.object({
    description: z.string(),
    requiredConceptRegexes: z.array(z.string()),
    regexFlags: z.string().optional(),
    uncreditedClaims: z.array(z.string()).optional(),
  }).nullable(),
  warningOrCriticalRegressionsAllowed: z.number().int().nonnegative().optional(),
});

const labelsSchema = z.object({
  schemaVersion: z.literal(1),
  benchmark: z.string(),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  scoringPolicy: z.object({
    evaluateOnlyIntroducedRegressions: z.boolean(),
    suggestionsAreReportedSeparatelyFromWarningCriticalFalsePositives: z.boolean(),
  }),
  cases: z.record(z.string(), caseSchema),
});

export type Labels = z.infer<typeof labelsSchema>;
export type CaseLabel = z.infer<typeof caseSchema>;
export interface LoadedLabels { readonly sha256: string; readonly labels: Labels }

export function loadLabels(path: string): LoadedLabels {
  const text = readText(path);
  return { sha256: contentHash(text), labels: readJson(path, labelsSchema) };
}

// ---- adjudications ----------------------------------------------------------------------------------------------

export const VERDICTS = ["correct", "partial", "incorrect", "false_positive", "valid_additional", "out_of_scope"] as const;
export type AdjudicatedVerdict = (typeof VERDICTS)[number];

const adjudicationSchema = z.object({
  caseId: z.string(),
  runId: z.string(),
  findingIndex: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  verdict: z.enum(VERDICTS),
  note: z.string().trim().min(10),
  reviewer: z.string().optional(),
});

export type Adjudication = z.infer<typeof adjudicationSchema>;

export function loadAdjudications(path: string): readonly Adjudication[] {
  const list = readJson(path, z.object({ adjudications: z.array(adjudicationSchema) })).adjudications;
  const seen = new Set<string>();
  for (const a of list) {
    const key = `${a.caseId}|${a.runId}|${a.findingIndex}`;
    if (seen.has(key)) throw new EvalInputError(`duplicate adjudication for ${key}`);
    seen.add(key);
  }
  return list;
}

// ---- runs -------------------------------------------------------------------------------------------------------

const NO_METRICS: RunMetrics = { tokensIn: null, tokensOut: null, tokensLowerBound: false, modelRequests: null, toolCalls: null, retries: null, providerErrors: [], durationMs: null };

/** Detects the artifact kind from what is on disk: a lean folder, a legacy folder, or a recorded demo evidence file. */
export function loadRun(path: string): Run {
  if (!existsSync(path)) throw new EvalInputError(`run artifact not found: ${basename(path)}`);
  if (statSync(path).isFile()) return loadDemo(path);
  if (existsSync(join(path, "lean-findings.json"))) return loadLean(path);
  if (existsSync(join(path, "metrics.json"))) return loadLegacy(path);
  throw new EvalInputError(`${basename(path)} has neither lean-findings.json nor metrics.json`);
}

const leanSchema = z.object({
  status: z.enum(["complete", "incomplete"]),
  reason: z.string().optional(),
  findings: z.array(findingSchema).default([]),
  dropped: z.array(z.string()).default([]),
  tokensIn: count.optional(),
  tokensOut: count.optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
}).refine((f) => f.status === "incomplete" || f.reason === undefined || f.reason === "nothing_to_review", { message: "a complete run may only carry the reason nothing_to_review" });

const traceLine = z.object({ event: z.string(), ms: count.optional(), status: z.union([z.string(), z.number()]).optional(), code: z.string().optional() });

function leanTrace(path: string): Pick<RunMetrics, "modelRequests" | "toolCalls" | "retries" | "providerErrors" | "durationMs"> {
  const events = readText(path).split("\n").filter((l) => l.trim() !== "").map((line, i) => {
    try { return traceLine.parse(JSON.parse(line)); } catch { throw new EvalInputError(`${basename(path)} line ${i + 1} is not a trace event`); }
  });
  const of = (name: string) => events.filter((e) => e.event === name);
  return {
    modelRequests: of("request").length,
    toolCalls: of("tool").length,
    retries: of("retry_wait").length,
    providerErrors: of("provider_error").map((e) => `${e.status ?? "?"}_${e.code ?? "?"}`),
    durationMs: of("end")[0]?.ms ?? null,
  };
}

function loadLean(dir: string): Run {
  const file = readJson(join(dir, "lean-findings.json"), leanSchema);
  const tracePath = join(dir, "lean-trace.jsonl");
  const trace = existsSync(tracePath) ? leanTrace(tracePath) : {};
  return {
    source: "lean",
    runId: basename(dir),
    status: file.status,
    // A complete run normally has no reason; "nothing_to_review" marks one that was skipped without a model call.
    reason: file.status === "incomplete" ? (file.reason ?? "unknown") : (file.reason ?? null),
    baseSha: file.baseSha ?? null,
    headSha: file.headSha ?? null,
    findings: file.findings,
    citationKept: file.findings.length,
    citationDropped: file.dropped.length,
    metrics: { ...NO_METRICS, ...trace, tokensIn: file.tokensIn ?? null, tokensOut: file.tokensOut ?? null },
  };
}

const legacySchema = z.object({
  completion: z.enum(["complete", "incomplete"]),
  tokens: z.object({ input: count, output: count }),
  usage: z.object({ lowerBound: z.boolean() }).optional(),
  retries: count.optional(),
  durationMs: count.optional(),
  findings: z.object({ total: count }),
});

function legacyReason(report: string): string | null {
  const failed = /^## Failed reviewers\s*\n- [a-z_]+: ([a-z_]+)/m.exec(report)?.[1];
  return failed ?? /^The review did not finish[^\n]*\n(?:[^\n]*\n)*?- [a-z_]+: ([a-z_]+)/m.exec(report)?.[1] ?? null;
}

/**
 * Legacy OpenCode runs. Only incomplete ones are supported: their findings live in prose in report.md, and this scorer
 * does not parse prose into findings. A complete legacy run is refused rather than guessed at.
 */
function loadLegacy(dir: string): Run {
  const metrics = readJson(join(dir, "metrics.json"), legacySchema);
  if (metrics.completion !== "incomplete" || metrics.findings.total !== 0) throw new EvalInputError(`${basename(dir)}: only incomplete legacy runs with no findings are supported`);
  const report = existsSync(join(dir, "report.md")) ? readText(join(dir, "report.md")) : "";
  const range = /^Range: ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/m.exec(report);
  const logPath = join(dir, "run.jsonl");
  const log = existsSync(logPath) ? readText(logPath).split("\n").filter((l) => l.trim() !== "") : null;
  const events = (name: string): number | null => log === null ? null : log.filter((l) => l.includes(`"event":"${name}"`)).length;
  return {
    source: "legacy",
    runId: basename(dir),
    status: "incomplete",
    reason: legacyReason(report) ?? "unknown",
    baseSha: range?.[1] ?? null,
    headSha: range?.[2] ?? null,
    findings: [],
    citationKept: 0,
    citationDropped: 0,
    metrics: { ...NO_METRICS, tokensIn: metrics.tokens.input, tokensOut: metrics.tokens.output, tokensLowerBound: metrics.usage?.lowerBound ?? false, toolCalls: events("tool_call"), retries: events("session_retry") ?? metrics.retries ?? null, durationMs: metrics.durationMs ?? null },
  };
}

const demoSchema = z.object({
  base: z.string(),
  head: z.string(),
  finding: findingSchema,
  stats: z.object({
    status: z.enum(["complete", "incomplete"]),
    ms: count.optional(),
    model_requests: count.optional(),
    tool_calls: count.optional(),
    investigation_tokens_in: count.optional(),
    investigation_tokens_out: count.optional(),
    citations_verified: count.optional(),
  }),
});

/** The recorded SQL-injection demo (docs/assets/cra-demo-evidence.json). There is no label for it, so it is never detection-scored. */
function loadDemo(path: string): Run {
  const demo = readJson(path, demoSchema);
  const s = demo.stats;
  return {
    source: "demo",
    runId: basename(path).replace(/\.json$/, ""),
    status: s.status,
    reason: s.status === "incomplete" ? "unknown" : null,
    baseSha: demo.base,
    headSha: demo.head,
    findings: [demo.finding],
    citationKept: s.citations_verified ?? 0,
    citationDropped: null,
    metrics: { ...NO_METRICS, tokensIn: s.investigation_tokens_in ?? null, tokensOut: s.investigation_tokens_out ?? null, modelRequests: s.model_requests ?? null, toolCalls: s.tool_calls ?? null, durationMs: s.ms ?? null },
  };
}

// ---- independent citation re-check ---------------------------------------------------------------------------------

/**
 * Checks each finding's citation against the benchmark repository at the head commit, independently of the reviewer's own
 * check: the file exists there, the line exists, and that line contains the first line of the quoted evidence.
 * A citation that fails here is invalid. `git` is run without a shell and only with a validated commit id.
 */
export async function recheckCitations(benchRepo: string, headSha: string, findings: readonly RunFinding[]): Promise<readonly boolean[]> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new EvalInputError("citation re-check needs a full 40-character head commit");
  const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
  return Promise.all(findings.map(async (f) => {
    const spec = `${headSha}:${f.file.replace(/\\/g, "/").replace(/^\.\//, "")}`;
    try {
      const { stdout } = await run("git", ["-C", benchRepo, "show", spec], { maxBuffer: 5_000_000 });
      const line = stdout.split(/\r?\n/)[f.line - 1];
      const quoted = squash(f.evidence.split(/\r?\n/).find((l) => l.trim() !== "") ?? "");
      return line !== undefined && quoted !== "" && squash(line).includes(quoted);
    } catch { return false; }
  }));
}
