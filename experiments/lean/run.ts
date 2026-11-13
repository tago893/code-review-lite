import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FINDINGS_SCHEMA } from "../../src/agents/structured.js";
import { parseReviewerOutput } from "../../src/findings/schema.js";
import type { Roots } from "../../src/mcp/paths.js";
import type { Category, Finding } from "../../src/types.js";
import { verifyCitation } from "../../src/verify/citation.js";
import { gateForModel } from "../../src/workspace/gate.js";
import { loadReviewContext } from "../../src/workspace/review-context.js";
import { createChat, ProviderError, type ChatFn, type ToolUseFailure } from "./client.js";
import { investigate, type TraceEvent } from "./loop.js";
import { buildProvenance, reviewerFromEnv, UNKNOWN_REVIEWER, type Provenance, type ReviewerIdentity } from "./provenance.js";

// Lean reviewer: one model, one bounded tool loop (investigate), then one separate structured call with no tools.
// reviewLean is the whole review; main() below is only the command line around it.

export interface LeanOptions {
  readonly repo: string;
  readonly ctx: string;
  readonly prompts: string;
  readonly category: Category;
  readonly model: string;
  readonly chat: ChatFn;
  readonly maxTurns: number;
  readonly maxRequestBytes: number;
  readonly historyBytes: number;
  readonly maxForbiddenToolCalls: number;
  /** Which reviewer code is running, as told by whoever launched it. Unknown (null) when not supplied. */
  readonly reviewer?: ReviewerIdentity;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: TraceEvent) => void;
}

export interface LeanResult {
  readonly status: "complete" | "incomplete";
  readonly reason?: string;
  /** Findings whose file, line and quoted code were found in the snapshot. */
  readonly findings: readonly Finding[];
  /** Fixed reason codes of findings the model reported but the citation check rejected. */
  readonly dropped: readonly string[];
  readonly baseSha: string;
  readonly headSha: string;
  /** How this result was produced: reviewer commit, model, prompt and configuration hashes, reviewed range. */
  readonly provenance: Provenance;
  readonly turns: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** True when the one tool_use_failed recovery was started (its request can still be stopped by the size budget or deadline). */
  readonly recoveryAttempted: boolean;
  /** Why the provider rejected a tool call (fixed words), when it did. */
  readonly diagnostic?: ToolUseFailure;
  /** Changed files nobody reviewed (generated, binary, lockfile...), redacted. A complete review says nothing about them. */
  readonly unreviewed: readonly string[];
}

const PHASE2_HEADING = /^## Phase 2\b.*$/m;
const NO_FINDINGS = "No findings.";

export async function reviewLean(o: LeanOptions): Promise<LeanResult> {
  const context = await loadReviewContext(o.ctx, o.repo, o.prompts);
  const [shared, category, sharedContext] = await Promise.all([
    readFile(join(o.prompts, "REVIEWER_SHARED.md"), "utf8"),
    readFile(join(o.prompts, `${o.category}.md`), "utf8"),
    readFile(context.paths.sharedContextPath, "utf8"),
  ]);
  const provenance = buildProvenance({
    reviewer: o.reviewer ?? UNKNOWN_REVIEWER, meta: context.meta, model: o.model, category: o.category,
    promptText: [shared, category],
    settings: { maxTurns: o.maxTurns, maxRequestBytes: o.maxRequestBytes, historyBytes: o.historyBytes, maxForbiddenToolCalls: o.maxForbiddenToolCalls },
  });
  const base = { baseSha: context.meta.baseSha, headSha: context.meta.headSha, provenance, unreviewed: context.plan.unreviewed };
  const stop = (reason: string, extra: Partial<LeanResult> = {}): LeanResult =>
    Object.freeze({ status: "incomplete", reason, findings: [], dropped: [], turns: 0, tokensIn: 0, tokensOut: 0, recoveryAttempted: false, ...base, ...extra });

  // The plan was decided on the trusted side from the net diff. Nothing to review (for example a bug that a later commit
  // reverted exactly) needs no model call; changes nobody can analyse must not become a clean result. Same rules as the
  // original pipeline (src/pipeline.ts).
  if (context.plan.disposition === "manual_review") return stop("manual_review_required");
  // The reason marks the result, so a skip is never mistaken for a review in which a model looked and found nothing.
  if (context.plan.disposition === "skip_clean") return Object.freeze({ status: "complete", reason: "nothing_to_review", findings: [], dropped: [], turns: 0, tokensIn: 0, tokensOut: 0, recoveryAttempted: false, ...base });

  const split = PHASE2_HEADING.exec(shared)?.index ?? shared.length;
  const gatedContext = gateForModel("phase1_context", sharedContext);
  if (gatedContext.status !== "ok") return stop(`sanitization_failed_${gatedContext.reason}`);

  const roots: Roots = { primary: o.repo, extra: [o.ctx] };
  const system = `${shared.slice(0, split)}\n${category}`;
  const user = [`Per-file patches are in ${context.paths.patchDir}. The change under review:`, "<shared_context>", gatedContext.text, "</shared_context>", "Investigate now. When done, reply with your Phase 1 notes (plain text, no tool call)."].join("\n\n");
  const phase1 = await investigate({ chat: o.chat, model: o.model, system, user, roots, maxTurns: o.maxTurns, maxRequestBytes: o.maxRequestBytes, historyBytes: o.historyBytes, maxForbiddenToolCalls: o.maxForbiddenToolCalls, onEvent: o.onEvent, ...(o.signal ? { signal: o.signal } : {}) });
  const usage = { turns: phase1.turns, tokensIn: phase1.tokensIn, tokensOut: phase1.tokensOut, recoveryAttempted: phase1.recoveryAttempted, ...(phase1.diagnostic ? { diagnostic: phase1.diagnostic } : {}) };
  if (phase1.status === "incomplete") return stop(phase1.reason ?? "incomplete", usage);

  const notes = gateForModel("phase2_notes", phase1.notes);
  if (notes.status !== "ok") return stop(`sanitization_failed_${notes.reason}`, usage);
  if (notes.text.trim() === NO_FINDINGS) return Object.freeze({ status: "complete", findings: [], dropped: [], ...base, ...usage });

  let content: string;
  try {
    const reply = await o.chat({
      model: o.model,
      messages: [{ role: "system", content: shared.slice(split) }, { role: "user", content: notes.text }],
      response_format: { type: "json_schema", json_schema: { name: "findings", strict: true, schema: FINDINGS_SCHEMA } },
      temperature: 0,
    });
    content = extractContent(reply.json);
    o.onEvent({ event: "structured", bytes: Buffer.byteLength(content), retries: reply.retries });
  } catch (error) {
    if (error instanceof ProviderError) o.onEvent({ event: "provider_error", phase: "structured", status: error.status, code: error.code, type: error.errorType, retries: error.retries });
    return stop(error instanceof ProviderError ? (error.code === "deadline" ? "deadline" : error.message) : "malformed_response", usage);
  }

  const parsed = parseReviewerOutput(content, o.category);
  const findings: Finding[] = [];
  const dropped: string[] = [];
  for (const finding of parsed.findings) {
    const check = await verifyCitation(finding, { repoRoot: o.repo, entries: context.plan.entries });
    if (check.ok) findings.push(finding);
    else dropped.push(check.reason ?? "rejected");
  }
  o.onEvent({ event: "verified", findings: findings.length, dropped: dropped.length, rejectedItems: parsed.rejected?.length ?? 0 });
  // Items the schema check discarded mean the output was not fully usable, so the review is not reported as complete.
  if (parsed.error !== undefined) return stop("findings_invalid", { ...usage, findings, dropped });
  return Object.freeze({ status: "complete", findings, dropped, ...base, ...usage });
}

function extractContent(json: unknown): string {
  const content = (json as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("malformed_response");
  return content;
}

// ---- command line -------------------------------------------------------------------------------------------------

const int = (value: string | undefined, fallback: number): number => {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error("bad_number");
  return n;
};

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i] ?? "", argv[i + 1] ?? "");
  const [repo, ctx, prompts, out] = ["--repo", "--ctx", "--prompts", "--out"].map((k) => args.get(k));
  const baseUrl = env["GROQ_BASE_URL"];
  // The default assistant looks for bugs and logic flaws (uReview's "Standard" assistant); security is opt-in.
  const category = (args.get("--category") ?? "code_quality") as Category;
  if (!repo || !ctx || !prompts || !out || !baseUrl || !["code_quality", "security", "performance"].includes(category)) {
    process.stderr.write("usage: run.js --repo <dir> --ctx <dir> --prompts <dir> --out <dir> [--category security|code_quality|performance]; GROQ_BASE_URL must be set\n");
    return 64;
  }
  mkdirSync(out, { recursive: true });
  const tracePath = join(out, "lean-trace.jsonl");
  writeFileSync(tracePath, "");
  const started = Date.now();
  const onEvent = (event: TraceEvent): void => { appendFileSync(tracePath, `${JSON.stringify({ t: Date.now() - started, ...event })}\n`); };

  const signal = AbortSignal.timeout(int(env["REVIEW_DEADLINE_MINUTES"], 10) * 60_000);
  const chat = createChat({ baseUrl, signal, onRetry: (r) => onEvent({ event: "retry_wait", retryNo: r.retryNo, waitMs: r.waitMs }) });
  const result = await reviewLean({
    repo, ctx, prompts, category, chat, signal, onEvent,
    model: env["REVIEWER_MODEL"] || "openai/gpt-oss-120b",
    reviewer: reviewerFromEnv(env),
    maxTurns: int(env["REVIEW_INVESTIGATION_STEPS"], 12),
    maxRequestBytes: int(env["LEAN_REQUEST_BUDGET_BYTES"], 32_000),
    historyBytes: int(env["LEAN_HISTORY_BYTES"], 8_000),
    maxForbiddenToolCalls: int(env["LEAN_MAX_FORBIDDEN_CALLS"], 3),
  }).catch((): { status: "incomplete"; reason: string } & Partial<LeanResult> => ({ status: "incomplete", reason: "internal_error" }));
  onEvent({ event: "end", status: result.status, reason: result.reason ?? "", ms: Date.now() - started });
  writeFileSync(join(out, "lean-findings.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`lean review ${result.status}${result.reason ? ` (${result.reason})` : ""}: ${result.findings?.length ?? 0} verified finding(s)\n`);
  return result.status === "complete" ? 0 : 2;
}

if (process.argv[1]?.endsWith("run.js")) void main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
