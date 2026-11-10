import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepare } from "../../src/cli/prepare.js";
import { loadReviewContext, type PreparedContext } from "../../src/workspace/review-context.js";
import { PROMPTS } from "../lean/fixture.js";

// Small synthetic git histories for the multi-commit tests, and the real trusted-side preparation run over them
// (the same function the `prepare` command uses). No model is involved: these tests check what the reviewer is GIVEN.

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

export const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
export const hasRg = (() => { try { execFileSync("rg", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

export interface Repo {
  readonly dir: string;
  git(...args: readonly string[]): string;
  /** Writes (or, with null, deletes) files, stages everything and commits. Returns the new commit SHA. */
  commit(message: string, files: Readonly<Record<string, string | null>>): string;
  cleanup(): void;
}

export function makeRepo(initial: Readonly<Record<string, string>>): Repo {
  const dir = mkdtempSync(join(tmpdir(), "mc-repo-"));
  const git = (...args: readonly string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  const repo: Repo = {
    dir,
    git,
    commit(message, files) {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) { rmSync(join(dir, path), { force: true }); continue; }
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  repo.commit("base", initial);
  return repo;
}

export interface Prepared {
  readonly exitCode: 0 | 2;
  readonly status: string;
  readonly outRepo: string;
  readonly outCtx: string;
  readonly context: PreparedContext;
}

/** Runs the real trusted-side `prepare` for base..head and loads the review context the reviewer would read. */
export async function prepareReview(repo: Repo, base: string, head: string): Promise<Prepared> {
  const root = mkdtempSync(join(tmpdir(), "mc-out-"));
  const outRepo = join(root, "repo");
  const outCtx = join(root, "ctx");
  const result = await prepare({ kind: "prepare", repo: repo.dir, base, head, outRepo, outCtx });
  const context = result.exitCode === 0 ? await loadReviewContext(outCtx, outRepo, PROMPTS) : (undefined as never);
  return { ...result, outRepo, outCtx, context };
}

// ---- the shared starting point: a payment function, and callers of it that no scenario changes ----------------------

export const VALIDATION = "  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error(\"invalid amount\");";

export const PAY_V0 = [
  "// Payment helpers. Amounts are integer cents.",
  "const CURRENCY = \"USD\";",
  "const MAX_CENTS = 100_000_00;",
  "",
  "export function describe(amountCents: number): string {",
  "  return `${(amountCents / 100).toFixed(2)} ${CURRENCY}`;",
  "}",
  "",
  "export function charge(amountCents: number): string {",
  VALIDATION,
  "  if (amountCents > MAX_CENTS) throw new Error(\"amount too large\");",
  "  return `charged:${amountCents}`;",
  "}",
  "",
].join("\n");

export const BASE_FILES: Readonly<Record<string, string>> = {
  "src/pay.ts": PAY_V0,
  "src/checkout.ts": "import { charge } from \"./pay\";\n\nexport const receipt = (cents: number): string => charge(cents).toUpperCase();\n",
  "README.md": "# fixture\n",
};
