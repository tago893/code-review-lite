import { z } from "zod";
import type { Finding } from "../types.js";

export const MAX_OUTPUT_CHARS = 1_000_000;
export const MAX_FINDINGS = 50;
const MAX_CANDIDATES = 20;

const rawFinding = z.object({
  id: z.string().min(1).max(100).optional(),
  category: z.enum(["code_quality", "security", "performance"]),
  severity: z.enum(["critical", "warning", "suggestion"]),
  file: z.string().min(1).max(512),
  line: z.number().int().positive().max(10_000_000),
  evidence: z.string().refine((s) => s.trim().length > 0).pipe(z.string().max(2000)),
  claim: z.string().min(1).max(2000),
  path: z.string().min(1).max(1000),
});

/** An item that failed validation: its position and the names of the fields that were wrong, never their values. */
export interface RejectedItem {
  readonly index: number;
  readonly fields: readonly string[];
}

export interface ParsedReviewerOutput {
  readonly findings: readonly Finding[];
  /** Set when the output was unusable or some items were dropped. A fixed description: it never quotes the output. */
  readonly error?: string;
  /** Items dropped for being invalid. Present only when there were some. Zero findings plus an `error` is NOT a clean review. */
  readonly rejected?: readonly RejectedItem[];
}

/**
 * Extracts and validates a reviewer's JSON findings. Never throws. Invalid items are dropped and counted in
 * `error`; unusable output (no JSON, truncated, wrong shape, too large) yields no findings and an error.
 * Unknown keys are discarded, so a reviewer cannot set `level` or anything else we did not ask for.
 */
export function parseReviewerOutput(raw: string, reviewer: string): ParsedReviewerOutput {
  try {
    if (typeof raw !== "string") return failure("invalid_input");
    if (raw.length > MAX_OUTPUT_CHARS) return failure("output_too_large");
    if (raw.trim().length === 0) return failure("empty_output");
    const items = findItems(raw);
    if (items === undefined) return failure("no_valid_json_findings");
    if (items.length > MAX_FINDINGS) return failure(`too_many_findings (max ${MAX_FINDINGS})`);
    return validate(items, reviewer);
  } catch {
    return failure("internal_error"); // the cause is dropped on purpose: it could quote the output
  }
}

function validate(items: readonly unknown[], reviewer: string): ParsedReviewerOutput {
  const findings: Finding[] = [];
  const rejected: RejectedItem[] = [];
  items.forEach((item, index) => {
    const parsed = rawFinding.safeParse(item);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "(item)")))];
      rejected.push(Object.freeze({ index, fields: Object.freeze(fields) }));
      return;
    }
    const { id, ...rest } = parsed.data;
    findings.push(Object.freeze({ ...rest, id: id ?? `${reviewer}-${index + 1}`, reviewer }));
  });
  const frozen = Object.freeze(findings);
  return rejected.length === 0
    ? Object.freeze({ findings: frozen })
    : Object.freeze({
        findings: frozen,
        error: `${rejected.length} of ${items.length} findings invalid and dropped`,
        rejected: Object.freeze(rejected),
      });
}

function failure(error: string): ParsedReviewerOutput {
  return Object.freeze({ findings: Object.freeze([]), error });
}

// --- JSON extraction ----------------------------------------------------------------------------------------

/** The findings array from a bare array, an object with a `findings` array, or either inside prose or a code fence. */
function findItems(raw: string): readonly unknown[] | undefined {
  for (const text of candidateTexts(raw)) {
    const items = itemsOf(tryParse(text));
    if (items) return items;
  }
  return undefined;
}

function* candidateTexts(raw: string): Generator<string> {
  yield raw.trim();
  for (const fence of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) yield (fence[1] ?? "").trim();
  let tried = 0;
  for (let i = 0; i < raw.length && tried < MAX_CANDIDATES; i++) {
    const open = raw.charAt(i);
    if (open !== "[" && open !== "{") continue;
    tried++;
    const end = balancedEnd(raw, i);
    if (end !== -1) yield raw.slice(i, end + 1);
  }
}

function itemsOf(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && "findings" in value) {
    const inner = (value as { findings: unknown }).findings;
    if (Array.isArray(inner)) return inner;
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Index of the bracket that closes the one at `start`, skipping string contents; -1 if it never closes. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if ((ch === "]" || ch === "}") && --depth === 0) return i;
  }
  return -1;
}
