import { sanitizeForModel, type RedactionFinding } from "../safety/sanitize.js";

/** Where in the pipeline text is about to cross to a model. */
export type GateStage = "phase1_context" | "phase2_notes";

export type GateResult =
  | { readonly status: "ok"; readonly text: string; readonly findings: readonly RedactionFinding[] }
  | { readonly status: "incomplete"; readonly stage: GateStage; readonly reason: string };

/**
 * The single crossing point to a model. Phase 1 context and Phase 1 investigation notes (before they feed
 * Phase 2) both go through here. A failure returns "incomplete" with a reason code and no text: callers must
 * stop the review and report it, never fall back to the raw text.
 */
export function gateForModel(stage: GateStage, text: string): GateResult {
  const result = sanitizeForModel(text);
  if (!result.ok) return Object.freeze({ status: "incomplete" as const, stage, reason: result.reason });
  return Object.freeze({ status: "ok" as const, text: result.text, findings: result.findings });
}
