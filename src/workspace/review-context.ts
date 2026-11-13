import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ReviewerPaths } from "../agents/reviewers.js";
import type { ReviewPlan } from "../plan.js";
import { redactSecrets } from "../safety/redact.js";
import { WorkspaceError } from "./errors.js";

// Writes and reads the review context under /review/context. Writing happens on the trusted side before the agent
// container starts; the agent side only reads, from a read-only mount.

/** About 6k tokens: the shared provider limit is small, so the inline diff is capped and the rest is read from patches/. */
export const MAX_SHARED_CONTEXT_CHARS = 24_000;
const READY = "READY";
const MAX_PATCH_NAME = 180;

export interface ContextMeta {
  /** The commit the change is reviewed against (the merge base of the requested base and the head). */
  readonly baseSha: string;
  readonly headSha: string;
  /** The base as requested, when it differs from `baseSha` because the target branch moved on. */
  readonly requestedBaseSha?: string;
  /** The pull request's commits, oldest first. SHAs only: commit messages are untrusted text and never reach the reviewer. */
  readonly commitShas?: readonly string[];
  /** The true number of commits; `commitShas` may be capped. */
  readonly commitCount?: number;
}

const entrySchema = z.object({
  oldPath: z.string(), newPath: z.string(), status: z.enum(["added", "modified", "deleted", "renamed"]),
  addedLines: z.array(z.string()), removedLines: z.array(z.string()),
  addedLineNumbers: z.array(z.number().int()), removedLineNumbers: z.array(z.number().int()),
  isBinary: z.boolean(), isRename: z.boolean(), patch: z.string(),
});

const planSchema = z.object({
  tier: z.enum(["trivial", "lite", "full"]),
  agents: z.array(z.enum(["code_quality", "security", "performance"])),
  reasons: z.array(z.string()), uncertainties: z.array(z.string()),
  size: z.object({ changedLines: z.number(), files: z.number() }),
  entries: z.array(entrySchema),
  excluded: z.array(z.object({ path: z.string(), kind: z.string(), reason: z.string() })),
  withheld: z.array(z.string()), disposition: z.enum(["review", "skip_clean", "manual_review"]),
  manualReasons: z.array(z.string()), unreviewed: z.array(z.string()),
  meta: z.object({ baseSha: z.string(), headSha: z.string(), requestedBaseSha: z.string().optional(), commitShas: z.array(z.string()).optional(), commitCount: z.number().int().nonnegative().optional() }),
});

/** A patch file name for a repo path: separators and anything unusual become "__" / "_", so it stays inside patches/. */
export const patchFileName = (path: string): string => `${path.replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_PATCH_NAME)}.patch`;

/** Writes shared-context.txt, patches/<file>.patch, plan.json and, last, the READY marker. */
export async function writeReviewContext(ctxDir: string, plan: ReviewPlan, meta: ContextMeta): Promise<void> {
  await mkdir(join(ctxDir, "patches"), { recursive: true, mode: 0o755 });
  for (const entry of plan.entries) await writeFile(join(ctxDir, "patches", patchFileName(entry.newPath)), entry.patch, { mode: 0o644, flag: "w" });
  await writeFile(join(ctxDir, "shared-context.txt"), sharedContext(plan, meta), { mode: 0o644 });
  await writeFile(join(ctxDir, "plan.json"), JSON.stringify({ ...plan, meta }), { mode: 0o644 });
  await writeFile(join(ctxDir, READY), "ready\n", { mode: 0o644 });
}

function sharedContext(plan: ReviewPlan, meta: ContextMeta): string {
  const diff = plan.entries.map((e) => e.patch).join("");
  const header = [
    `Review of ${meta.baseSha.slice(0, 12)}..${meta.headSha.slice(0, 12)}; tier ${plan.tier}; ${plan.size.changedLines} changed lines in ${plan.size.files} files.`,
    plan.reasons.length > 0 ? `Why this tier:\n${plan.reasons.map((r) => `- ${r}`).join("\n")}` : "",
    plan.withheld.length > 0 ? `Changed, content withheld (sensitive): ${plan.withheld.join(", ")}` : "",
    plan.excluded.length > 0 ? `Not reviewed:\n${plan.excluded.map((x) => `- ${x.path} (${x.kind}: ${x.reason})`).join("\n")}` : "",
    plan.uncertainties.length > 0 ? `Behavior impact unknown:\n${plan.uncertainties.map((u) => `- ${u}`).join("\n")}` : "",
  ].filter((s) => s !== "").join("\n\n");
  const room = Math.max(0, MAX_SHARED_CONTEXT_CHARS - header.length);
  const body = diff.length > room
    ? `${diff.slice(0, room)}\n[diff truncated: ${diff.length - room} more characters. Read the full per-file patches under /review/context/patches.]\n`
    : diff;
  return redactSecrets(`${header}\n\nDiff:\n${body}`);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export interface PreparedContext {
  readonly plan: ReviewPlan;
  readonly meta: ContextMeta;
  readonly paths: ReviewerPaths;
}

/** Reads the prepared context. Fails with a fixed WorkspaceError if the READY marker or a valid plan is missing. */
export async function loadReviewContext(ctxDir: string, repoRoot: string, promptDir: string): Promise<PreparedContext> {
  const exists = await readFile(join(ctxDir, READY), "utf8").then(() => true, () => false);
  if (!exists) throw new WorkspaceError("source_missing");
  const parsed = planSchema.safeParse(await readJson(join(ctxDir, "plan.json")));
  if (!parsed.success) throw new WorkspaceError("internal_error");
  const { meta, ...plan } = parsed.data;
  return {
    plan: plan as ReviewPlan,
    meta: meta as ContextMeta,
    paths: { repoRoot, sharedContextPath: join(ctxDir, "shared-context.txt"), patchDir: join(ctxDir, "patches"), promptDir },
  };
}
