import { redactSecrets, redactSecretsDetailed, type RedactionFinding } from "./redact.js";

export { describeRedactions, redactSecrets, redactSecretsDetailed } from "./redact.js";
export type { RedactionFinding, RedactionKind, RedactOptions, RedactionResult } from "./redact.js";

const BOUNDARY_NAMES =
  "mr_input|mr_body|mr_comments|mr_details|changed_files|previous_review|custom_review_instructions|shared_context|candidate_findings";
// Optional whitespace is allowed anywhere a browser or model would still read the text as a tag.
const BOUNDARY_TAG = new RegExp(`<\\s*/?\\s*(?:${BOUNDARY_NAMES})(?![A-Za-z0-9_])[^>\\n]*>?`, "gi");
const MAX_STRIP_PASSES = 10;

/**
 * Removes the prompt's boundary tags from untrusted text so it cannot close a section and open its own.
 * Repeats until stable, because removing a tag nested inside another can assemble a new one.
 */
export function stripBoundaryTags(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = current.replace(BOUNDARY_TAG, "");
    if (next === current) return next;
    current = next;
  }
  // Still changing after the cap: drop every angle bracket rather than risk passing a tag through.
  return current.replace(/[<>]/g, "");
}

const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;

/** A copy of `env` without credentials: by name (*_KEY, *_TOKEN, *_SECRET, *_PASSWORD) and by secret-looking value. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SECRET_NAME.test(name)) continue;
    if (redactSecrets(value) !== value) continue;
    clean[name] = value;
  }
  return Object.freeze(clean);
}

export type SanitizeFailure = "invalid_input" | "too_large" | "internal_error";

export type SanitizeResult =
  | { readonly ok: true; readonly text: string; readonly findings: readonly RedactionFinding[] }
  | { readonly ok: false; readonly reason: SanitizeFailure };

export interface SanitizeOptions {
  readonly maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 5_000_000;

/**
 * The gate for text that is about to reach a model: strip boundary tags, redact secrets, then check the
 * result is clean. On any failure it returns a reason code and nothing from the input, so the caller must
 * treat the content as unusable. It never throws and never echoes input.
 */
export function sanitizeForModel(text: string, options: SanitizeOptions = {}): SanitizeResult {
  try {
    if (typeof text !== "string") return fail("invalid_input");
    if (text.length > (options.maxChars ?? DEFAULT_MAX_CHARS)) return fail("too_large");
    const first = redactSecretsDetailed(stripBoundaryTags(text));
    const check = redactSecretsDetailed(first.text);
    if (check.text !== first.text) return fail("internal_error"); // a second pass found more: do not trust the first
    return Object.freeze({ ok: true as const, text: first.text, findings: first.findings });
  } catch {
    return fail("internal_error"); // the error is dropped on purpose: its message could contain the input
  }
}

function fail(reason: SanitizeFailure): SanitizeResult {
  return Object.freeze({ ok: false as const, reason });
}
