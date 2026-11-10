import { createHash } from "node:crypto";
import type { ContextMeta } from "../../src/workspace/review-context.js";
import { toolDefinitions } from "./tools.js";

// What a future run artifact records about HOW it was produced, so a score can be tied to an exact reviewer, model,
// prompt and configuration. Nothing here is guessed: a value that was not supplied is null. Historical artifacts are
// never rewritten; they simply have no provenance block.

export interface ReviewerIdentity {
  /** Full commit of the reviewer code that ran, supplied by whoever launched the run (the container has no .git). */
  readonly commit: string | null;
  /** True when that checkout had uncommitted changes, so the commit alone does not identify the code. */
  readonly dirty: boolean | null;
}

export const UNKNOWN_REVIEWER: ReviewerIdentity = Object.freeze({ commit: null, dirty: null });

export interface Provenance {
  readonly schemaVersion: 1;
  readonly reviewerCommit: string | null;
  readonly reviewerDirty: boolean | null;
  /** The model as configured for the request. */
  readonly model: string;
  readonly category: string;
  /** sha256 of the exact prompt text the model is given (shared prompt, category prompt, tool note). */
  readonly promptSha256: string;
  /** sha256 of the run settings and the tool definitions the model is offered. */
  readonly configSha256: string;
  /** The commit reviewed against (the merge base) and the final head. */
  readonly baseSha: string;
  readonly headSha: string;
  /** The base as requested, when the context recorded one. */
  readonly requestedBaseSha: string | null;
  readonly commitCount: number | null;
}

export interface ProvenanceInput {
  readonly reviewer: ReviewerIdentity;
  readonly meta: ContextMeta;
  readonly model: string;
  readonly category: string;
  readonly promptText: readonly string[];
  readonly settings: Readonly<Record<string, number>>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Reads the launcher-supplied identity. Anything malformed is recorded as unknown, never repaired. */
export function reviewerFromEnv(env: NodeJS.ProcessEnv): ReviewerIdentity {
  const commit = env["CRA_REVIEWER_COMMIT"];
  const dirty = env["CRA_REVIEWER_DIRTY"];
  return Object.freeze({
    commit: commit !== undefined && FULL_SHA.test(commit) ? commit : null,
    dirty: dirty === "1" ? true : dirty === "0" ? false : null,
  });
}

export function buildProvenance(input: ProvenanceInput): Provenance {
  const settings = Object.fromEntries(Object.entries(input.settings).sort(([a], [b]) => (a < b ? -1 : 1)));
  return Object.freeze({
    schemaVersion: 1,
    reviewerCommit: input.reviewer.commit,
    reviewerDirty: input.reviewer.dirty,
    model: input.model,
    category: input.category,
    promptSha256: sha256(JSON.stringify(input.promptText)),
    configSha256: sha256(JSON.stringify({ model: input.model, category: input.category, temperature: 0, settings, tools: toolDefinitions })),
    baseSha: input.meta.baseSha,
    headSha: input.meta.headSha,
    requestedBaseSha: input.meta.requestedBaseSha ?? null,
    commitCount: input.meta.commitShas?.length ?? null,
  });
}
