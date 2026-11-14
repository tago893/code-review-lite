import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planReview, type ReviewPlan } from "../../src/plan.js";
import type { ChangeMap } from "../../src/workspace/change-map.js";
import { MAX_SHARED_CONTEXT_CHARS, loadReviewContext, patchFileName, writeReviewContext } from "../../src/workspace/review-context.js";

const add = (path: string, body: string[]): string =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`), ""].join("\n");
const planOf = (diff: string): ReviewPlan => {
  const p = planReview(diff);
  if (!p.ok) throw new Error("plan failed");
  return p.plan;
};
const meta = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("review context", () => {
  it("round-trips the plan and writes READY last", async () => {
    const plan = planOf(add("src/a.ts", ["export const a = 1;"]));
    await writeReviewContext(dir, plan, meta);
    const loaded = await loadReviewContext(dir, "/repo", "/prompts");
    expect(loaded.plan).toEqual(JSON.parse(JSON.stringify(plan)));
    expect(loaded.meta).toEqual(meta);
    expect(loaded.paths).toMatchObject({ repoRoot: "/repo", promptDir: "/prompts" });
    expect(readFileSync(loaded.paths.sharedContextPath, "utf8")).toContain("export const a = 1;");
    expect(existsSync(join(loaded.paths.patchDir, "src__a.ts.patch"))).toBe(true);
  });

  it("truncates the inline diff and points to the per-file patches", async () => {
    const plan = planOf(add("src/big.ts", Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`)));
    await writeReviewContext(dir, plan, meta);
    const text = readFileSync(join(dir, "shared-context.txt"), "utf8");
    expect(text.length).toBeLessThan(MAX_SHARED_CONTEXT_CHARS + 500);
    expect(text).toContain("diff truncated");
    expect(readFileSync(join(dir, "patches", "src__big.ts.patch"), "utf8")).toContain("v3999");
  });

  it("never writes a secret into the shared context", async () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    await writeReviewContext(dir, planOf(add("src/a.ts", [`const k = "${secret}";`])), meta);
    expect(readFileSync(join(dir, "shared-context.txt"), "utf8")).not.toContain(secret);
  });

  it("fails with a fixed error when READY is missing or plan.json is invalid", async () => {
    await expect(loadReviewContext(dir, "/r", "/p")).rejects.toMatchObject({ code: "source_missing" });
    await writeReviewContext(dir, planOf(add("src/a.ts", ["x"])), meta);
    rmSync(join(dir, "plan.json"));
    await expect(loadReviewContext(dir, "/r", "/p")).rejects.toMatchObject({ code: "internal_error" });
  });

  it("keeps patch file names inside the patches directory", () => {
    expect(patchFileName("../../etc/passwd")).not.toContain("/");
    expect(patchFileName("a/b c.ts")).toBe("a__b_c.ts.patch");
  });

  const map: ChangeMap = {
    functions: [{ path: "src/a.ts", span: { name: "run", startLine: 1, endLine: 3 }, changedLines: [2], callersSearched: true, callers: [], moreCallers: 0 }],
    omittedFunctions: 0, unreadableFiles: 0,
  };

  it("puts the change map before the diff and writes change-map.json", async () => {
    await writeReviewContext(dir, planOf(add("src/a.ts", ["export const a = 1;"])), meta, map);
    const text = readFileSync(join(dir, "shared-context.txt"), "utf8");
    expect(text).toContain("- src/a.ts:1-3 run (changed lines 2)");
    expect(text.indexOf("- src/a.ts:1-3 run")).toBeLessThan(text.indexOf("\nDiff:\n"));
    expect(JSON.parse(readFileSync(join(dir, "change-map.json"), "utf8"))).toEqual(map);
  });

  it("counts the change map against the shared context budget", async () => {
    const plan = planOf(add("src/big.ts", Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`)));
    await writeReviewContext(dir, plan, meta, map);
    expect(readFileSync(join(dir, "shared-context.txt"), "utf8").length).toBeLessThan(MAX_SHARED_CONTEXT_CHARS + 500);
  });

  it("writes no section and no change-map.json without a map", async () => {
    await writeReviewContext(dir, planOf(add("src/a.ts", ["x"])), meta);
    expect(readFileSync(join(dir, "shared-context.txt"), "utf8")).not.toContain("Changed functions");
    expect(existsSync(join(dir, "change-map.json"))).toBe(false);
  });
});
