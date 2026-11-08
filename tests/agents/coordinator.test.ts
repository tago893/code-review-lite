import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyJudgments, judge, type JudgeDeps } from "../../src/agents/coordinator.js";
import type { ExploreSession } from "../../src/agents/opencode.js";
import type { StructuredCall } from "../../src/agents/structured.js";
import type { Finding } from "../../src/types.js";

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id, category: "security", severity: "warning", file: "src/a.ts", line: 3, evidence: "e", claim: `claim ${id}`, path: "p", reviewer: "security", level: "citation_valid", ...over,
});
const judgments = (...items: object[]) => JSON.stringify({ judgments: items });
const j = (id: string, status: string, over: object = {}) => ({ id, status, trace: `read src/a.ts for ${id}`, category: "keep", duplicateOf: "", ...over });

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coord-"));
  writeFileSync(join(dir, "coordinator.md"), "# Coordinator\nPhase 1 text\n\n## Phase 2: structured\nPhase 2 text\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Calls { explored: string[]; structured: string[]; sessions: number }
function deps(notes: string, structuredContent: string, calls: Calls = { explored: [], structured: [], sessions: 0 }): { d: JudgeDeps; calls: Calls } {
  const session: ExploreSession = { explore: async (i) => { calls.explored.push(i.prompt); return { text: notes, tokensIn: 3, tokensOut: 2, tokensKnown: true }; }, close: async () => undefined };
  const structured: StructuredCall = async (r) => { calls.structured.push(`${r.system}|${r.user}`); return { content: structuredContent, tokensIn: 4, tokensOut: 1 }; };
  return { d: { sessions: async () => { calls.sessions += 1; return session; }, structured, model: "big", repoRoot: dir, promptPath: join(dir, "coordinator.md") }, calls };
}

describe("judge", () => {
  it("makes no model call when there are no candidates", async () => {
    const { d, calls } = deps("x", "{}");
    expect(await judge([], d)).toMatchObject({ kept: [], refuted: 0 });
    expect(calls.sessions).toBe(0);
  });

  it("promotes supported findings, drops refuted ones and counts them", async () => {
    const { d } = deps("notes", judgments(j("a", "supported"), j("b", "refuted")));
    const result = await judge([finding("a"), finding("b")], d);
    expect(result.kept.map((f) => [f.id, f.level])).toEqual([["a", "semantically_supported"]]);
    expect(result.refuted).toBe(1);
    expect(result.traces["a"]).toContain("read src/a.ts");
    expect(result.tokensIn).toBe(7);
  });

  it("keeps a plausible finding at citation_valid", async () => {
    const result = applyJudgments([finding("a")], judgments(j("a", "plausible")));
    expect(result.kept[0]?.level).toBe("citation_valid");
  });

  it("drops duplicates, re-categorises, and ignores unknown ids", () => {
    const result = applyJudgments(
      [finding("a"), finding("b"), finding("c")],
      judgments(j("b", "supported", { duplicateOf: "a" }), j("c", "supported", { category: "performance" }), j("zzz", "supported"), j("a", "supported", { duplicateOf: "nope" })),
    );
    expect(result.kept.map((f) => f.id)).toEqual(["a", "c"]);
    expect(result.duplicates).toBe(1);
    expect(result.kept.find((f) => f.id === "c")?.category).toBe("performance");
  });

  it("keeps exactly one canonical representative for a duplicate cycle (A->B and B->A), whatever the order", () => {
    const cycle = judgments(j("a", "supported", { duplicateOf: "b" }), j("b", "supported", { duplicateOf: "a" }));
    for (const order of [[finding("a"), finding("b")], [finding("b"), finding("a")]]) {
      const result = applyJudgments(order, cycle);
      expect(result.kept).toHaveLength(1);
      expect(result.duplicates).toBe(1);
      expect(result.kept[0]?.id).toBe(order[0]?.id); // equal rank: the earliest reported wins, deterministically
    }
  });

  it("collapses longer cycles and chains to one finding, preferring supported then more severe", () => {
    const ring = applyJudgments(
      [finding("a"), finding("b", { severity: "critical" }), finding("c")],
      judgments(j("a", "supported", { duplicateOf: "b" }), j("b", "plausible", { duplicateOf: "c" }), j("c", "supported", { duplicateOf: "a" })),
    );
    expect(ring.kept.map((f) => f.id)).toEqual(["a"]);
    expect(ring.duplicates).toBe(2);
    expect(ring.kept[0]?.level).toBe("semantically_supported");
  });

  it("preserves the merged duplicates' evidence in the representative's trace", () => {
    const result = applyJudgments(
      [finding("a", { reviewer: "security" }), finding("b", { reviewer: "performance", file: "src/b.ts", line: 9, claim: "same flaw seen elsewhere", evidence: "the evidence" })],
      judgments(j("a", "supported", { duplicateOf: "b" }), j("b", "supported", { duplicateOf: "a" })),
    );
    expect(result.traces["a"]).toContain("also reported by performance at src/b.ts:9");
    expect(result.traces["a"]).toContain("the evidence");
  });

  it("does not let a refuted finding be a representative or lose the group its survivor", () => {
    const result = applyJudgments([finding("a"), finding("b")], judgments(j("a", "refuted", { duplicateOf: "b" }), j("b", "supported", { duplicateOf: "a" })));
    expect(result.kept.map((f) => f.id)).toEqual(["b"]);
    expect(result.refuted).toBe(1);
    expect(result.duplicates).toBe(0);
  });

  it("ignores any level the coordinator tries to set: only 'supported' status maps to semantically_supported", () => {
    const sneaky = JSON.stringify({ judgments: [{ ...j("a", "plausible"), level: "independently_confirmed", severity: "critical" }] });
    const result = applyJudgments([finding("a", { severity: "warning" })], sneaky);
    expect(result.kept[0]).toMatchObject({ level: "citation_valid", severity: "warning" });
  });

  it("never promotes anything when the coordinator output is malformed, and leaves unmentioned findings capped", () => {
    for (const bad of ["not json", "{}", JSON.stringify({ judgments: [{ id: "a", status: "supported" }] }), JSON.stringify({ judgments: [{ id: "a", status: "great", trace: "t" }] })]) {
      expect(applyJudgments([finding("a")], bad).kept[0]?.level).toBe("citation_valid");
    }
    expect(applyJudgments([finding("a"), finding("b")], judgments(j("a", "supported"))).kept[1]?.level).toBe("citation_valid");
  });

  it("does not treat 'No findings.' notes as a judgment of the candidates", async () => {
    const { d, calls } = deps("No findings.", "{}");
    const result = await judge([finding("a")], d);
    expect(result.kept[0]?.level).toBe("citation_valid");
    expect(calls.structured).toEqual([]);
  });

  it("fails when the coordinator writes empty notes (a failure, not a pass)", async () => {
    const { d } = deps("   ", "{}");
    await expect(judge([finding("a")], d)).rejects.toThrow();
  });

  it("splits the prompt: tools phase gets the candidates, the structured call gets only the notes", async () => {
    const { d, calls } = deps("my notes", judgments(j("a", "supported")));
    await judge([finding("a")], d);
    expect(calls.explored[0]).toContain("Phase 1 text");
    expect(calls.explored[0]).not.toContain("Phase 2 text");
    expect(calls.explored[0]).toContain("claim a");
    expect(calls.structured[0]).toBe("## Phase 2: structured\nPhase 2 text\n|my notes");
  });

  it("scrubs a session error and does not leak its text", async () => {
    const { d } = deps("x", "{}");
    const failing: JudgeDeps = { ...d, sessions: async () => { throw Object.assign(new Error("401 key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"), { status: 401 }); } };
    const error = await judge([finding("a")], failing).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("sk-proj");
  });
});
