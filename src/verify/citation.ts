import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { DiffEntry, Finding } from "../types.js";

export const MAX_VERIFY_FILE_BYTES = 2_000_000;
/** The evidence may start this many lines away from the cited line. */
export const LINE_TOLERANCE = 3;

export interface CitationResult {
  readonly ok: boolean;
  /** A fixed reason code. It never quotes the finding, so it cannot carry model text into logs or reports. */
  readonly reason?: string;
  /** True when the cited line, or the lines where the evidence was found, include an added line of the matching diff entry. */
  readonly touchesChangedLine: boolean;
}

export interface CitationContext {
  readonly repoRoot: string;
  readonly entries: readonly DiffEntry[];
}

class CitationPathError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CitationPathError";
  }
}

/**
 * Resolves a repository-relative path to its real path, and throws if that real path is not inside `root`.
 * Symlinked files and files below symlinked directories are followed by realpath and then rejected if they
 * leave the root. Messages are fixed codes and never contain the requested path.
 */
export async function safeResolve(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) throw new CitationPathError("invalid_path");
  if (isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\")) throw new CitationPathError("absolute_path");
  const lexical = normalize(rel);
  if (lexical === ".." || lexical.startsWith(".." + sep)) throw new CitationPathError("path_outside_root");

  const realRoot = await realpath(root).catch(() => fail("root_unavailable"));
  const real = await realpath(join(realRoot, lexical)).catch(() => fail("file_not_found"));
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new CitationPathError("path_outside_root");
  return real;
}

/**
 * Level 1 verification: the cited file exists inside the repository snapshot, the line is in range, and the
 * quoted evidence appears at or within 3 lines of it (whitespace and line endings normalised). It proves the
 * model points at real code, not that the code is wrong. Never throws.
 */
export async function verifyCitation(finding: Finding, ctx: CitationContext): Promise<CitationResult> {
  try {
    const lines = await readLines(ctx.repoRoot, finding.file);
    if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > lines.length) return rejected("line_out_of_range");
    const evidence = normalizeText(finding.evidence);
    if (evidence.length === 0) return rejected("empty_evidence");
    const start = locateEvidence(lines, finding.line, evidence, finding.evidence.split(/\r?\n/).length);
    if (start === undefined) return rejected("evidence_not_found");
    const span = { from: start, to: start + finding.evidence.split(/\r?\n/).length - 1 };
    return Object.freeze({ ok: true, touchesChangedLine: touches(ctx.entries, finding, span) });
  } catch (error) {
    return rejected(error instanceof CitationPathError ? error.code : "verification_error");
  }
}

async function readLines(repoRoot: string, file: string): Promise<readonly string[]> {
  const real = await safeResolve(repoRoot, file);
  const info = await stat(real);
  if (!info.isFile()) throw new CitationPathError("not_a_file");
  if (info.size > MAX_VERIFY_FILE_BYTES) throw new CitationPathError("file_too_large");
  return (await readFile(real, "utf8")).split(/\r\n|\n/);
}

/** First line (closest to the cited one) where the evidence begins, or undefined. */
function locateEvidence(lines: readonly string[], cited: number, evidence: string, evidenceLines: number): number | undefined {
  const first = Math.max(1, cited - LINE_TOLERANCE);
  const last = Math.min(lines.length, cited + LINE_TOLERANCE);
  const candidates = Array.from({ length: last - first + 1 }, (_, i) => first + i).sort(
    (a, b) => Math.abs(a - cited) - Math.abs(b - cited) || a - b,
  );
  return candidates.find((start) => normalizeText(lines.slice(start - 1, start - 1 + evidenceLines).join("\n")).includes(evidence));
}

function touches(entries: readonly DiffEntry[], finding: Finding, span: { from: number; to: number }): boolean {
  const entry = entries.find((e) => e.newPath === finding.file && e.status !== "deleted");
  if (!entry) return false;
  return entry.addedLineNumbers.some((n) => n === finding.line || (n >= span.from && n <= span.to));
}

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

const rejected = (reason: string): CitationResult => Object.freeze({ ok: false, reason, touchesChangedLine: false });

function fail(code: string): never {
  throw new CitationPathError(code);
}
