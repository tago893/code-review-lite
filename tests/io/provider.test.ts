import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputError, fileSink, localGitProvider } from "../../src/io/provider.js";
import { createMetrics } from "../../src/observability/metrics.js";

const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
let repo = "";
let baseSha = "";
let headSha = "";
const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" } }).trim();

describe.skipIf(!hasGit)("localGitProvider", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "git-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    baseSha = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git("commit", "-q", "-am", "head");
    headSha = git("rev-parse", "HEAD");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const load = (over: object = {}) => localGitProvider({ repoDir: repo, base: baseSha, head: "HEAD", ...over }).load();

  it("pins revisions to SHAs and regenerates the diff", async () => {
    const input = await load({ base: "HEAD~1" });
    expect(input).toMatchObject({ baseSha, headSha, repoRoot: repo });
    expect(input.diffText).toContain("+export const a = 2;");
  });

  it("accepts a supplied diff only when it equals the regenerated one", async () => {
    const same = join(repo, "..", `same-${Date.now()}.patch`);
    writeFileSync(same, `${(await load()).diffText}\n`);
    await expect(load({ diffFile: same })).resolves.toBeDefined();
    const other = join(repo, "..", `other-${Date.now()}.patch`);
    writeFileSync(other, "diff --git a/x b/x\n");
    await expect(load({ diffFile: other })).rejects.toMatchObject({ code: "diff_mismatch" });
    await expect(load({ diffFile: join(repo, "nope.patch") })).rejects.toMatchObject({ code: "diff_unreadable" });
    rmSync(same); rmSync(other);
  });

  it("rejects option-like and unknown revisions with fixed codes", async () => {
    await expect(load({ base: "--output=/tmp/x" })).rejects.toMatchObject({ code: "bad_revision" });
    await expect(load({ base: "does-not-exist" })).rejects.toMatchObject({ code: "rev_not_found" });
    await expect(load({ base: "" })).rejects.toBeInstanceOf(InputError);
  });

  it("requires HEAD to be the head revision and the tree to be clean", async () => {
    await expect(load({ head: baseSha })).rejects.toMatchObject({ code: "head_not_checked_out" });
    writeFileSync(join(repo, "untracked.txt"), "x");
    await expect(load()).rejects.toMatchObject({ code: "tree_not_clean" });
  });

  it("does not put revision text in error messages", async () => {
    await expect(load({ base: "secret-branch-name" })).rejects.toThrow(/^rev_not_found$/);
  });
});

describe("fileSink", () => {
  it("writes the report and metrics.json next to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sink-"));
    mkdirSync(join(dir, "out"));
    await fileSink(join(dir, "out", "report.md")).write("# hi", createMetrics().recordRetry().snapshot());
    expect(readFileSync(join(dir, "out", "report.md"), "utf8")).toBe("# hi");
    expect(JSON.parse(readFileSync(join(dir, "out", "metrics.json"), "utf8"))).toMatchObject({ retries: 1 });
    rmSync(dir, { recursive: true, force: true });
  });
});
