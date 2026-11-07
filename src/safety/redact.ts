import {
  AUTH_HEADER,
  BARE_BEARER,
  CONNECTION_STRING,
  PEM_FOOTER,
  PEM_HEADER,
  PROVIDER_KEY_PATTERNS,
  REDACTED,
  SECRET_ASSIGNMENT,
  isBearerCredential,
  isPlaceholder,
  looksLikeSecretLiteral,
  type RedactionKind,
} from "./patterns.js";

export type { RedactionKind } from "./patterns.js";

/** Where and what was redacted. Deliberately carries no part of the secret. */
export interface RedactionFinding {
  readonly kind: RedactionKind;
  /** 1-based line in the input text. */
  readonly line: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
}

export interface RedactOptions {
  /** Input is a unified diff: keep the leading +/-/space marker on redacted key lines, end key blocks at hunk headers. */
  readonly diff?: boolean;
}

type Replacer = (line: string) => string;

/**
 * Replaces secrets in place. Never adds or removes a line, so line numbers and paths stay valid; the
 * non-secret parts of every line are byte-identical. Pure and deterministic.
 */
export function redactSecretsDetailed(text: string, options: RedactOptions = {}): RedactionResult {
  const lines = text.split("\n");
  const found: RedactionFinding[] = [];
  const out: string[] = [];
  let inKey = false;
  let keyLine = 0;
  let keyNoted = false;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const note = (kind: RedactionKind): void => {
      if (!found.some((f) => f.kind === kind && f.line === lineNo)) found.push(Object.freeze({ kind, line: lineNo }));
    };
    if (inKey) {
      const ended = PEM_FOOTER.test(line);
      const endsAtHunk = options.diff === true && /^@@|^diff --git /.test(line);
      if (endsAtHunk) {
        inKey = false;
        out.push(redactLine(line, note));
        return;
      }
      const redacted = redactKeyBodyLine(line, options.diff === true, ended);
      if (redacted !== line && !keyNoted) {
        // Report the key at its header line, where a reader will look for it.
        found.push(Object.freeze({ kind: "private_key" as const, line: keyLine }));
        keyNoted = true;
      }
      out.push(redacted);
      if (ended) inKey = false;
      return;
    }
    const keyed = redactKeyHeaderLine(line, note);
    if (keyed.opens) {
      inKey = true;
      keyLine = lineNo;
      keyNoted = keyed.changed;
    }
    out.push(keyed.opens || keyed.changed ? keyed.line : redactLine(line, note));
  });

  return Object.freeze({ text: out.join("\n"), findings: Object.freeze(found) });
}

export function redactSecrets(text: string, options: RedactOptions = {}): string {
  return redactSecretsDetailed(text, options).text;
}

/** A log-safe summary: counts per kind, never values. */
export function describeRedactions(findings: readonly RedactionFinding[]): string {
  if (findings.length === 0) return "no redactions";
  const counts = new Map<RedactionKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const parts = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}: ${n}`);
  const n = findings.length;
  return `${n} redaction${n === 1 ? "" : "s"} (${parts.join(", ")})`;
}

// --- private keys -----------------------------------------------------------------------------------------

interface HeaderOutcome {
  readonly line: string;
  readonly opens: boolean;
  readonly changed: boolean;
}

/** Handles a line holding a PEM header. A key whose footer is on the same line is redacted there. */
function redactKeyHeaderLine(line: string, note: (kind: RedactionKind) => void): HeaderOutcome {
  const header = PEM_HEADER.exec(line);
  if (!header) return { line, opens: false, changed: false };
  const afterHeader = header.index + header[0].length;
  const rest = line.slice(afterHeader);
  const footer = PEM_FOOTER.exec(rest);
  if (footer) {
    const middle = rest.slice(0, footer.index);
    if (middle === REDACTED || middle === "") return { line, opens: false, changed: false };
    note("private_key");
    return { line: line.slice(0, afterHeader) + REDACTED + rest.slice(footer.index), opens: false, changed: true };
  }
  const tail = rest.replace(/\r$/, "");
  if (tail.length === 0 || tail === REDACTED) return { line, opens: true, changed: false };
  note("private_key");
  return { line: line.slice(0, afterHeader) + REDACTED + (rest.endsWith("\r") ? "\r" : ""), opens: true, changed: true };
}

/** A body line becomes "[REDACTED]". The footer line is left as it is. */
function redactKeyBodyLine(line: string, diff: boolean, isFooter: boolean): string {
  if (isFooter) return line;
  const cr = line.endsWith("\r") ? "\r" : "";
  const marker = diff && /^[+\- ]/.test(line) ? line.charAt(0) : "";
  return marker + REDACTED + cr;
}

// --- everything else, one line at a time ------------------------------------------------------------------

function redactLine(line: string, note: (kind: RedactionKind) => void): string {
  let current = line;
  for (const pattern of PROVIDER_KEY_PATTERNS) {
    current = current.replace(pattern, () => (note("provider_key"), REDACTED));
  }
  const steps: readonly Replacer[] = [
    (l) => l.replace(AUTH_HEADER, (_m, head: string) => (note("auth_header"), head + REDACTED)),
    (l) => redactConnectionStrings(l, note),
    (l) => redactBareBearer(l, note),
    (l) => redactAssignments(l, note),
  ];
  return steps.reduce((acc, step) => step(acc), current);
}

function redactConnectionStrings(line: string, note: (kind: RedactionKind) => void): string {
  return line.replace(CONNECTION_STRING, (match, head: string, password: string, at: string) => {
    if (isPlaceholder(password) || password.includes("${")) return match;
    note("connection_string");
    return head + REDACTED + at;
  });
}

function redactBareBearer(line: string, note: (kind: RedactionKind) => void): string {
  return line.replace(BARE_BEARER, (match, head: string, token: string) => {
    if (!isBearerCredential(token)) return match;
    note("bearer_token");
    return head + REDACTED;
  });
}

function redactAssignments(line: string, note: (kind: RedactionKind) => void): string {
  return line.replace(
    SECRET_ASSIGNMENT,
    (match, head: string, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
      if (dq !== undefined) return replaceValue(match, head, dq, '"', true, note);
      if (sq !== undefined) return replaceValue(match, head, sq, "'", true, note);
      return replaceValue(match, head, bare ?? "", "", false, note);
    },
  );
}

function replaceValue(
  match: string,
  head: string,
  value: string,
  quote: string,
  quoted: boolean,
  note: (kind: RedactionKind) => void,
): string {
  if (!looksLikeSecretLiteral(value, quoted)) return match;
  note("secret_assignment");
  return head + quote + REDACTED + quote;
}
