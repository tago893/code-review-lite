import { gateForModel } from "../workspace/gate.js";
import type { Finding } from "../types.js";
import { readSnapshotLines, verifyCitation } from "./citation.js";

export type VerifierAnswer = "agrees" | "disagrees";
export type Verifier = (finding: Finding, codeSnippet: string) => Promise<VerifierAnswer>;

export interface ConfirmOptions {
  /** The sanitised, read-only snapshot. Required: the snippet is always read from it, never taken from the model. */
  readonly repoRoot: string;
  /** Lines of surrounding code shown on each side of the cited line. */
  readonly contextLines?: number;
}

const DEFAULT_CONTEXT_LINES = 8;

/**
 * Asks a verifier session whether it agrees with the finding. A true result means "a verifier model agreed": it is
 * CORROBORATION, not proof the bug is real (label it with BASIS_LABEL.verifier).
 *
 * The verifier sees the finding (without its level) and a numbered excerpt read from the sanitised snapshot after the
 * finding's citation verified against that snapshot. The model's quoted evidence is never substituted for source, so
 * if the snapshot or the citation is unavailable, or the excerpt cannot be sanitised, the result is false and the
 * verifier is not called. Only an exact "agrees" confirms; "disagrees", any other answer, or a throw is false.
 * It never throws. Choosing a verifier on a different model than the reporter is the caller's job.
 */
export async function confirmWithVerifier(finding: Finding, verifier: Verifier, options: ConfirmOptions): Promise<boolean> {
  try {
    if (typeof options?.repoRoot !== "string" || options.repoRoot.length === 0) return false;
    const citation = await verifyCitation(finding, { repoRoot: options.repoRoot, entries: [] });
    if (!citation.ok) return false;
    const gated = gateForModel("phase2_notes", await excerpt(finding, options));
    if (gated.status !== "ok") return false;
    const { level: _level, ...withoutLevel } = finding;
    return (await verifier(Object.freeze(withoutLevel), gated.text)) === "agrees";
  } catch {
    return false;
  }
}

async function excerpt(finding: Finding, options: ConfirmOptions): Promise<string> {
  const lines = await readSnapshotLines(options.repoRoot, finding.file);
  const radius = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const from = Math.max(1, finding.line - radius);
  const to = Math.min(lines.length, finding.line + radius);
  return lines
    .slice(from - 1, to)
    .map((text, i) => `${from + i}: ${text}`)
    .join("\n");
}
