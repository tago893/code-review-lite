import { readFile } from "node:fs/promises";
import { z } from "zod";
import { gateForModel } from "../workspace/gate.js";
import type { Category, Finding } from "../types.js";
import type { SessionProvider } from "./opencode.js";
import { ReviewerSecurityError, type SecurityStage } from "./runner.js";
import { scrubProviderError } from "./scrub.js";
import type { StructuredCall } from "./structured.js";

/** Phase 2 schema for the coordinator. Strict mode: every property required, no extras. */
export const COORDINATOR_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["supported", "refuted", "plausible"] },
          trace: { type: "string" },
          category: { type: "string", enum: ["keep", "code_quality", "security", "performance"] },
          duplicateOf: { type: "string" },
        },
        required: ["id", "status", "trace", "category", "duplicateOf"],
        additionalProperties: false,
      },
    },
  },
  required: ["judgments"],
  additionalProperties: false,
});

const judgmentsSchema = z.object({
  judgments: z.array(z.object({
    id: z.string(), status: z.enum(["supported", "refuted", "plausible"]), trace: z.string().max(2000),
    category: z.enum(["keep", "code_quality", "security", "performance"]).default("keep"), duplicateOf: z.string().default(""),
  })),
});

export interface JudgeDeps {
  readonly sessions: SessionProvider;
  readonly structured: StructuredCall;
  readonly model: string;
  readonly repoRoot: string;
  readonly promptPath: string;
  readonly signal?: AbortSignal;
}

export interface JudgeResult {
  /** Findings that survived, with `level` set to semantically_supported where the coordinator confirmed the claim. */
  readonly kept: readonly Finding[];
  readonly refuted: number;
  readonly duplicates: number;
  /** One-sentence traces by finding id, for the report. */
  readonly traces: Readonly<Record<string, string>>;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

const NO_FINDINGS = "No findings.";

/**
 * The coordinator: dedupes, re-categorises and checks candidate findings against the read-only snapshot. It never
 * adds findings. Unknown ids in its output are ignored and unmentioned findings stay at citation_valid, so a
 * coordinator that says little can only leave findings capped, never promote them. Everything sent to a model goes
 * through gateForModel; a gate failure throws ReviewerSecurityError. Provider errors are scrubbed.
 */
export async function judge(findings: readonly Finding[], deps: JudgeDeps): Promise<JudgeResult> {
  if (findings.length === 0) return { kept: [], refuted: 0, duplicates: 0, traces: {}, tokensIn: 0, tokensOut: 0 };

  const prompt = await readFile(deps.promptPath, "utf8");
  const split = /^## Phase 2\b.*$/m.exec(prompt);
  const phase1 = split ? prompt.slice(0, split.index) : prompt;
  const phase2 = split ? prompt.slice(split.index) : prompt;

  const candidates = gate("phase1_context", describeCandidates(findings));
  const session = await deps.sessions(deps.repoRoot).catch((e: unknown) => { throw scrubProviderError(e); });
  const signal = deps.signal ? { signal: deps.signal } : {};
  const explored = await session
    .explore({ model: deps.model, prompt: `${phase1}\n\n<candidate_findings>\n${candidates}\n</candidate_findings>\n\nCheck them now and write your Phase 1 notes.`, ...signal })
    .catch((e: unknown) => { throw scrubProviderError(e); });

  const notes = gate("phase2_notes", explored.text).trim();
  if (notes.length === 0) throw Object.assign(new Error("provider_unknown"), { name: "ProviderError" });
  if (notes === NO_FINDINGS) {
    // The coordinator was given candidates, so "No findings." is not a judgment of them: leave them unpromoted.
    return { kept: [...findings], refuted: 0, duplicates: 0, traces: {}, tokensIn: explored.tokensIn, tokensOut: explored.tokensOut };
  }

  const structured = await deps.structured({ model: deps.model, system: phase2, user: notes, ...signal });
  const tokensIn = explored.tokensIn + structured.tokensIn;
  const tokensOut = explored.tokensOut + structured.tokensOut;
  return { ...applyJudgments(findings, structured.content), tokensIn, tokensOut };
}

function gate(stage: SecurityStage, text: string): string {
  const result = gateForModel(stage, text);
  if (result.status !== "ok") throw new ReviewerSecurityError(stage, result.reason);
  return result.text;
}

function describeCandidates(findings: readonly Finding[]): string {
  return findings
    .map((f) => `Id: ${f.id}\nCategory: ${f.category}\nSeverity: ${f.severity}\nLocation: ${f.file}:${f.line}\nEvidence: ${f.evidence}\nClaim: ${f.claim}\nPath: ${f.path}`)
    .join("\n\n");
}

type Judgment = z.infer<typeof judgmentsSchema>["judgments"][number];

const SEVERITY_RANK = { critical: 0, warning: 1, suggestion: 2 } as const;
const MAX_TRACE = 1500;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 240);

/**
 * Pure: merges parsed judgments into the findings. Malformed output means no judgments (nothing is promoted).
 * The coordinator can only set `semantically_supported` (a model's assessment), drop, re-categorise or mark duplicates;
 * no field of its output can set any other level. Duplicate claims form groups (connected components, so A->B and
 * B->A, or a longer cycle, is one group, never mutual deletion); each group keeps exactly one canonical representative:
 * supported before unsupported, then higher severity, then earliest in the reviewers' output. The others' locations,
 * claims and evidence are appended to the representative's trace so nothing relevant is lost.
 */
export function applyJudgments(findings: readonly Finding[], raw: string): Omit<JudgeResult, "tokensIn" | "tokensOut"> {
  const byId = new Map<string, Judgment>();
  for (const j of parse(raw)) if (!byId.has(j.id)) byId.set(j.id, j);

  const alive = findings.filter((f) => byId.get(f.id)?.status !== "refuted");
  const refuted = findings.length - alive.length;
  const groups = duplicateGroups(alive, byId);

  const kept: Finding[] = [];
  const traces: Record<string, string> = {};
  let duplicates = 0;
  for (const f of alive) {
    const group = groups.get(f.id) ?? [f];
    const rep = canonical(group, byId);
    if (rep.id !== f.id) { duplicates += 1; continue; }
    const j = byId.get(f.id);
    const others = group.filter((g) => g.id !== f.id);
    const parts = [...(j ? [j.trace] : []), ...others.map((o) => `also reported by ${o.reviewer} at ${o.file}:${o.line}: ${oneLine(o.claim)} (evidence: ${oneLine(o.evidence)})`)];
    if (parts.length > 0) traces[f.id] = parts.join(" | ").slice(0, MAX_TRACE);
    const category: Category = !j || j.category === "keep" ? f.category : j.category;
    kept.push({ ...f, category, ...(j?.status === "supported" ? { level: "semantically_supported" as const } : {}) });
  }
  return { kept, refuted, duplicates, traces };
}

/** Groups findings linked by duplicateOf edges (to other surviving findings), as connected components. */
function duplicateGroups(alive: readonly Finding[], byId: ReadonlyMap<string, Judgment>): Map<string, Finding[]> {
  const parent = new Map(alive.map((f) => [f.id, f.id]));
  const root = (id: string): string => { let r = id; while (parent.get(r) !== r) r = parent.get(r) ?? r; return r; };
  for (const f of alive) {
    const target = byId.get(f.id)?.duplicateOf ?? "";
    if (target !== "" && target !== f.id && parent.has(target)) parent.set(root(f.id), root(target));
  }
  const members = new Map<string, Finding[]>();
  for (const f of alive) members.set(root(f.id), [...(members.get(root(f.id)) ?? []), f]);
  return new Map(alive.map((f) => [f.id, members.get(root(f.id)) ?? [f]]));
}

function canonical(group: readonly Finding[], byId: ReadonlyMap<string, Judgment>): Finding {
  const rank = (f: Finding): [number, number] => [byId.get(f.id)?.status === "supported" ? 0 : 1, SEVERITY_RANK[f.severity]];
  return group.reduce((best, f) => {
    const [a, b] = [rank(best), rank(f)];
    return b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? f : best;
  });
}

function parse(raw: string): Judgment[] {
  try {
    const result = judgmentsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data.judgments : [];
  } catch {
    return [];
  }
}
