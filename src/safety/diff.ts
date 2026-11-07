import { parseUnifiedDiff } from "../diff/parse.js";
import type { DiffEntry } from "../types.js";
import { redactSecretsDetailed, type RedactionKind } from "./redact.js";

export interface EntryFinding {
  readonly path: string;
  readonly kind: RedactionKind;
  /** 1-based line within the file's patch text. */
  readonly line: number;
}

export type SanitizeEntriesResult =
  | { readonly ok: true; readonly entries: readonly DiffEntry[]; readonly findings: readonly EntryFinding[] }
  | { readonly ok: false; readonly reason: "reparse_mismatch" | "internal_error"; readonly path: string };

/**
 * Redacts secrets in every entry's patch and rebuilds the entry from the redacted patch, so `patch`,
 * `addedLines` and `removedLines` always agree. Redaction keeps the line count, so line numbers are unchanged.
 * If a rebuilt entry does not match the original's paths, status and line numbers, the whole batch is
 * refused: nothing from an unverified entry is returned.
 */
export function sanitizeEntries(entries: readonly DiffEntry[]): SanitizeEntriesResult {
  const clean: DiffEntry[] = [];
  const findings: EntryFinding[] = [];
  for (const entry of entries) {
    try {
      const redacted = redactSecretsDetailed(entry.patch, { diff: true });
      const rebuilt = redacted.text === entry.patch ? entry : rebuild(entry, redacted.text);
      if (!rebuilt) return fail("reparse_mismatch", entry.newPath);
      clean.push(rebuilt);
      for (const f of redacted.findings) findings.push(Object.freeze({ path: entry.newPath, kind: f.kind, line: f.line }));
    } catch {
      return fail("internal_error", entry.newPath); // the error text is dropped: it could echo the patch
    }
  }
  return Object.freeze({ ok: true as const, entries: Object.freeze(clean), findings: Object.freeze(findings) });
}

function rebuild(original: DiffEntry, redactedPatch: string): DiffEntry | undefined {
  const parsed = parseUnifiedDiff(redactedPatch);
  const [entry] = parsed;
  if (parsed.length !== 1 || !entry) return undefined;
  const same =
    entry.oldPath === original.oldPath &&
    entry.newPath === original.newPath &&
    entry.status === original.status &&
    entry.isBinary === original.isBinary &&
    sameNumbers(entry.addedLineNumbers, original.addedLineNumbers) &&
    sameNumbers(entry.removedLineNumbers, original.removedLineNumbers);
  return same ? entry : undefined;
}

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

function fail(reason: "reparse_mismatch" | "internal_error", path: string): SanitizeEntriesResult {
  return Object.freeze({ ok: false as const, reason, path });
}
