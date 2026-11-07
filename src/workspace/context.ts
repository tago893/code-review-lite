import { DiffParseError } from "../diff/errors.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import { redactSecrets } from "../safety/redact.js";
import { sanitizeEntries } from "../safety/diff.js";
import { WorkspaceError } from "./errors.js";
import { isSensitivePath } from "./sensitive.js";

export interface DiffContext {
  /** Sanitised unified diff text, the only form of the diff the reviewer sees. */
  readonly patch: string;
  readonly files: number;
  /** Changed paths whose content was withheld because the file is sensitive (env files, keys, ...). */
  readonly withheld: readonly string[];
}

/**
 * Builds the reviewer's diff from the raw diff: secrets redacted line for line, and the content of sensitive
 * files (.env, keys, credentials) withheld entirely. Withheld paths are still listed so the reviewer knows the
 * file changed. Throws WorkspaceError and never includes diff text in the error.
 */
export function buildDiffContext(rawDiff: string): DiffContext {
  const entries = parseEntries(rawDiff);
  const sensitive = (e: { oldPath: string; newPath: string }): boolean => isSensitivePath(e.newPath) || isSensitivePath(e.oldPath);
  const shown = entries.filter((e) => !sensitive(e));
  const withheld = entries.filter(sensitive).map((e) => redactSecrets(e.newPath));
  const clean = sanitizeEntries(shown);
  if (!clean.ok) throw new WorkspaceError("sanitize_failed");
  return Object.freeze({
    patch: clean.entries.map((e) => e.patch).join(""),
    files: clean.entries.length,
    withheld: Object.freeze(withheld),
  });
}

function parseEntries(rawDiff: string): ReturnType<typeof parseUnifiedDiff> {
  try {
    return parseUnifiedDiff(rawDiff);
  } catch (error) {
    if (error instanceof DiffParseError) throw new WorkspaceError("diff_parse_failed");
    throw new WorkspaceError("internal_error");
  }
}
