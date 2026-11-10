import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRun } from "../../eval/load.js";
import { reviewLean, type LeanOptions } from "../../experiments/lean/run.js";
import { reviewerFromEnv } from "../../experiments/lean/provenance.js";
import { loadReviewContext, writeReviewContext } from "../../src/workspace/review-context.js";
import { makeFixture, NOTES, PROMPTS, scripted, textTurn, toolTurn, type Fixture } from "./fixture.js";

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
function run(over: Partial<LeanOptions> = {}, chat: LeanOptions["chat"] = scripted(textTurn("No findings.")).chat, ctx = fx.ctx) {
  return reviewLean({ repo: fx.repo, ctx, prompts: PROMPTS, category: "security", model: "m", chat, maxTurns: 8, maxRequestBytes: 32_000, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: () => undefined, ...over });
}

describe("run provenance", () => {
  it("records the reviewed range, model, category, and prompt and configuration hashes", async () => {
    const { provenance: p } = await run();
    expect(p).toMatchObject({ schemaVersion: 1, model: "m", category: "security", baseSha: "a".repeat(40), headSha: "b".repeat(40), requestedBaseSha: null, commitCount: null });
    expect(p.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.configSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never invents the reviewer commit: unknown unless the launcher supplied it", async () => {
    expect((await run()).provenance).toMatchObject({ reviewerCommit: null, reviewerDirty: null });
    expect((await run({ reviewer: { commit: COMMIT, dirty: false } })).provenance).toMatchObject({ reviewerCommit: COMMIT, reviewerDirty: false });
  });

  it("reads the launcher's identity from the environment and treats anything malformed as unknown", () => {
    expect(reviewerFromEnv({ CRA_REVIEWER_COMMIT: COMMIT, CRA_REVIEWER_DIRTY: "1" })).toEqual({ commit: COMMIT, dirty: true });
    expect(reviewerFromEnv({ CRA_REVIEWER_COMMIT: COMMIT, CRA_REVIEWER_DIRTY: "0" })).toEqual({ commit: COMMIT, dirty: false });
    expect(reviewerFromEnv({})).toEqual({ commit: null, dirty: null });
    for (const bad of ["abc123", COMMIT.toUpperCase(), `${COMMIT}0`, "HEAD", ""]) expect(reviewerFromEnv({ CRA_REVIEWER_COMMIT: bad }).commit, bad).toBeNull();
    expect(reviewerFromEnv({ CRA_REVIEWER_DIRTY: "yes" }).dirty).toBeNull();
  });

  it("gives the same hashes for the same inputs and different ones when the prompt, model, category or settings change", async () => {
    const a = (await run()).provenance;
    expect((await run()).provenance).toEqual(a);
    expect((await run({ model: "other" })).provenance.configSha256).not.toBe(a.configSha256);
    expect((await run({ maxTurns: 9 })).provenance.configSha256).not.toBe(a.configSha256);
    expect((await run({ category: "performance" })).provenance).toMatchObject({ category: "performance" });
    expect((await run({ category: "performance" })).provenance.promptSha256).not.toBe(a.promptSha256);
    expect((await run({ model: "other" })).provenance.promptSha256).toBe(a.promptSha256);

    const prompts = mkdtempSync(join(tmpdir(), "prompts-"));
    cpSync(PROMPTS, prompts, { recursive: true });
    writeFileSync(join(prompts, "security.md"), `${readFileSync(join(prompts, "security.md"), "utf8")}\nOne more instruction.\n`);
    const changed = (await run({ prompts })).provenance;
    expect(changed.promptSha256).not.toBe(a.promptSha256);
    expect(changed.configSha256).toBe(a.configSha256);
  });

  it("is present on incomplete results too, and the evaluator still reads an artifact that carries it", async () => {
    const stuck = await run({ maxTurns: 2 }, scripted(toolTurn([["cra_list", {}]])).chat);
    expect(stuck).toMatchObject({ status: "incomplete", reason: "step_limit" });
    expect(stuck.provenance.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    const dir = mkdtempSync(join(tmpdir(), "lean-art-"));
    writeFileSync(join(dir, "lean-findings.json"), JSON.stringify(stuck));
    expect(loadRun(dir)).toMatchObject({ source: "lean", status: "incomplete", reason: "step_limit" });
  });

  it("records the pull request's requested base and commit count when the context has them", async () => {
    const { plan } = await loadReviewContext(fx.ctx, fx.repo, PROMPTS);
    const ctx = mkdtempSync(join(tmpdir(), "ctx-"));
    await writeReviewContext(ctx, plan, { baseSha: "c".repeat(40), headSha: "b".repeat(40), requestedBaseSha: "d".repeat(40), commitShas: ["e".repeat(40), "f".repeat(40)] });
    expect((await run({}, undefined, ctx)).provenance).toMatchObject({ baseSha: "c".repeat(40), requestedBaseSha: "d".repeat(40), commitCount: 2 });
  });
});

describe("plan dispositions", () => {
  async function withDisposition(disposition: "skip_clean" | "manual_review" | "review") {
    const { plan } = await loadReviewContext(fx.ctx, fx.repo, PROMPTS);
    const ctx = mkdtempSync(join(tmpdir(), "ctx-"));
    await writeReviewContext(ctx, { ...plan, disposition, manualReasons: disposition === "manual_review" ? ["unanalysed change: yarn.lock (lockfile)"] : [] }, { baseSha: "a".repeat(40), headSha: "b".repeat(40) });
    return ctx;
  }

  it("nothing to review is complete with no model call", async () => {
    const model = scripted(textTurn(NOTES));
    expect(await run({}, model.chat, await withDisposition("skip_clean"))).toMatchObject({ status: "complete", findings: [], turns: 0, tokensIn: 0 });
    expect(model.bodies()).toHaveLength(0);
  });

  it("changes nobody can analyse are incomplete, never a clean result, and cost no model call", async () => {
    const model = scripted(textTurn("No findings."));
    const r = await run({}, model.chat, await withDisposition("manual_review"));
    expect(r).toMatchObject({ status: "incomplete", reason: "manual_review_required", findings: [] });
    expect(model.bodies()).toHaveLength(0);
  });

  it("an ordinary review still reaches the model", async () => {
    const model = scripted(textTurn("No findings."));
    expect(await run({}, model.chat, await withDisposition("review"))).toMatchObject({ status: "complete" });
    expect(model.bodies()).toHaveLength(1);
  });
});
