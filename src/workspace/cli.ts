import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDiffContext } from "./context.js";
import { WorkspaceError, toWorkspaceError } from "./errors.js";
import { prepareWorkspace } from "./prepare.js";

// Trusted preparation entry point. Runs in the prep container, which has the raw checkout mounted read-only
// and the two output volumes writable; the agent container never sees the raw mount.
//   REVIEW_SOURCE_DIR  raw checkout            (default /raw/repo)
//   REVIEW_DIFF_FILE   raw unified diff        (default /raw/diff.patch)
//   REVIEW_OUT_REPO    becomes the agent /repo (default /out/repo)
//   REVIEW_OUT_CTX     becomes /review/context (default /out/context)

const READY_MARKER = "READY";

async function main(): Promise<number> {
  const env = process.env;
  const sourceDir = env["REVIEW_SOURCE_DIR"] ?? "/raw/repo";
  const diffFile = env["REVIEW_DIFF_FILE"] ?? "/raw/diff.patch";
  const outRepo = env["REVIEW_OUT_REPO"] ?? "/out/repo";
  const outCtx = env["REVIEW_OUT_CTX"] ?? "/out/context";

  const prepared = await prepareWorkspace({ sourceDir, outDir: outRepo });
  if (prepared.status === "error") return report({ status: "error", code: prepared.code });

  try {
    const rawDiff = await readFile(diffFile, "utf8").catch(() => {
      throw new WorkspaceError("diff_unreadable");
    });
    const diff = buildDiffContext(rawDiff);
    await mkdir(outCtx, { recursive: true, mode: 0o755 });
    await writeFile(join(outCtx, "diff.patch"), diff.patch, { mode: 0o644 });
    const manifest = { copied: prepared.copied, skipped: prepared.skipped, withheldFromDiff: diff.withheld };
    await writeFile(join(outCtx, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o644 });
    await writeFile(join(outCtx, READY_MARKER), "ready\n", { mode: 0o644 }); // written last: its absence means not ready
    return report({ status: "ready", files: prepared.copied.length, skipped: prepared.skipped.length });
  } catch (error) {
    return report({ status: "error", code: toWorkspaceError(error).code });
  }
}

function report(status: Readonly<Record<string, string | number>>): number {
  process.stdout.write(JSON.stringify(status) + "\n");
  return status["status"] === "ready" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    process.stdout.write(JSON.stringify({ status: "error", code: "internal_error" }) + "\n");
    process.exit(1);
  },
);
