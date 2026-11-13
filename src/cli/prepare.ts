import { InputError, localGitProvider } from "../io/provider.js";
import { planReview } from "../plan.js";
import { toWorkspaceError } from "../workspace/errors.js";
import { prepareWorkspace } from "../workspace/prepare.js";
import { writeReviewContext } from "../workspace/review-context.js";
import type { Command } from "./args.js";

type Prepare = Extract<Command, { kind: "prepare" }>;

/**
 * Trusted side. Runs with the raw checkout and no model access: pins revisions, plans from the RAW diff, copies the
 * redacted snapshot, and writes the review context. Returns a fixed status code; exit 0 only when READY was written.
 */
export async function prepare(cmd: Prepare): Promise<{ readonly exitCode: 0 | 2; readonly status: string }> {
  try {
    const input = await localGitProvider({ repoDir: cmd.repo, base: cmd.base, head: cmd.head, ...(cmd.diff ? { diffFile: cmd.diff } : {}) }).load();
    const planned = planReview(input.diffText);
    if (!planned.ok) return { exitCode: 2, status: planned.reason };
    const snapshot = await prepareWorkspace({ sourceDir: input.repoRoot, outDir: cmd.outRepo });
    if (snapshot.status === "error") return { exitCode: 2, status: `workspace_${snapshot.code}` };
    await writeReviewContext(cmd.outCtx, planned.plan, { baseSha: input.baseSha, headSha: input.headSha, requestedBaseSha: input.requestedBaseSha, commitShas: input.commitShas, commitCount: input.commitCount });
    return { exitCode: 0, status: "ready" };
  } catch (error) {
    return { exitCode: 2, status: error instanceof InputError ? error.code : `workspace_${toWorkspaceError(error).code}` };
  }
}
