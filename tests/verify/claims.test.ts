import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import type { DiffEntry, Finding } from "../../src/types.js";
import { applyLevels, detectConfirmation } from "../../src/verify/claims.js";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claims-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, lines: string[]): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), lines.join("\n") + "\n");
};

const finding = (over: Partial<Finding>): Finding => ({
  id: "f1", category: "security", severity: "critical", file: "src/users.ts", line: 1, evidence: "x", claim: "c", path: "p",
  reviewer: "r", level: "semantically_supported", ...over,
});

/** A diff entry produced by the real parser, so line numbers are what the parser would give. */
const entryFor = (path: string, hunk: string[]): DiffEntry => {
  const header = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const [parsed] = parseUnifiedDiff([...header, ...hunk, ""].join("\n"));
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
};
const ctx = (entries: DiffEntry[]) => ({ repoRoot: root, entries });

describe("applyLevels", () => {
  const critical = (id: string, level?: Finding["level"]): Finding => finding({ id, severity: "critical", ...(level ? { level } : { level: undefined as never }) });

  it("keeps a critical only when it is independently confirmed", () => {
    const out = applyLevels([critical("a", "semantically_supported")], new Set(["a"]));
    expect(out.kept[0]).toMatchObject({ severity: "critical", level: "independently_confirmed", label: "confirmed (basis unspecified); not proof of exploitability" });
    expect(out.kept[0]?.cappedFrom).toBeUndefined();
  });

  it("caps supported findings at warning and labels them", () => {
    const [kept] = applyLevels([critical("a", "semantically_supported")], new Set()).kept;
    expect(kept).toMatchObject({ severity: "warning", cappedFrom: "critical", label: "model-assessed support (coordinator), not independently confirmed" });
  });

  it("caps citation-only findings at suggestion and flags them unconfirmed", () => {
    const [kept] = applyLevels([critical("a", "citation_valid"), ], new Set()).kept;
    expect(kept).toMatchObject({ severity: "suggestion", cappedFrom: "critical", label: "unconfirmed" });
  });

  it("does not raise a finding that is not in the confirmed set, and never lowers a severity", () => {
    const warn = finding({ id: "w", severity: "warning", level: "semantically_supported" });
    const sugg = finding({ id: "s", severity: "suggestion", level: "semantically_supported" });
    const out = applyLevels([warn, sugg], new Set());
    expect(out.kept.map((k) => [k.severity, k.cappedFrom])).toEqual([["warning", undefined], ["suggestion", undefined]]);
  });

  it("separates refuted findings and findings that were never given a level", () => {
    const out = applyLevels([finding({ id: "r", level: "refuted" }), critical("u"), finding({ id: "k", level: "citation_valid" })], new Set());
    expect(out.refuted.map((r) => r.id)).toEqual(["r"]);
    expect(out.unleveled.map((u) => u.id)).toEqual(["u"]);
    expect(out.kept.map((k) => k.id)).toEqual(["k"]);
  });

  it("keeps a refuted finding refuted even if its id is in the confirmed set", () => {
    const out = applyLevels([finding({ id: "r", level: "refuted" })], new Set(["r"]));
    expect(out.refuted).toHaveLength(1);
    expect(out.kept).toHaveLength(0);
  });

  it("returns frozen results and does not mutate its input", () => {
    const input = [critical("a", "citation_valid")];
    const out = applyLevels(input, new Set());
    expect(Object.isFrozen(out.kept)).toBe(true);
    expect(Object.isFrozen(out.kept[0])).toBe(true);
    expect(input[0]?.severity).toBe("critical");
  });
});

describe("detectConfirmation: SQL built by concatenation", () => {
  const cite = (line: number, claim = "SQL injection: userId is concatenated into the query"): Finding =>
    finding({ line, claim, evidence: undefined as never });

  const run = async (code: string[], line: number, evidence: string, added: number[], claim?: string, over: Partial<Finding> = {}) => {
    put("src/users.ts", code);
    const entry = { ...entryFor("src/users.ts", ["@@ -0,0 +1,1 @@", "+x"]), addedLineNumbers: added } as DiffEntry;
    return detectConfirmation({ ...cite(line, claim), evidence, ...over }, ctx([entry]));
  };

  it.each([
    ["string concatenation", ['  return db.query("SELECT * FROM users WHERE id = " + userId);'], "db.query("],
    ["template literal", ["  return db.query(`SELECT * FROM users WHERE id = ${userId}`);"], "db.query("],
    ["python f-string", ['    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")'], "cursor.execute("],
    ["python % formatting", ['    cursor.execute("SELECT * FROM users WHERE id = %s" % user_id)'], "cursor.execute("],
    ["multi-line call", ["  return db.query(", '    "SELECT * FROM users WHERE id = " + userId', "  );"], "db.query("],
  ])("confirms %s reaching a query call", async (_n, code, evidence) => {
    expect(await run(code, 1, evidence, [1, 2, 3])).toBe(true);
  });

  it("confirms SQL built into a variable that is then passed to the query call", async () => {
    const code = ['  const q = "SELECT * FROM users WHERE name = \'" + name + "\'";', "  const rows = await pool.query(q);"];
    expect(await run(code, 2, "pool.query(q)", [1, 2])).toBe(true);
  });

  it.each([
    ["parameterized query", ['  return db.query("SELECT * FROM users WHERE id = $1", [userId]);']],
    ["tagged template", ["  return db.query(sql`SELECT * FROM users WHERE id = ${userId}`);"]],
    ["two literals joined", ['  return db.query("SELECT * FROM users " + "WHERE id = 1");']],
    ["concatenation but no query call", ['  log("SELECT * FROM users WHERE id = " + userId);']],
  ])("does not confirm a %s", async (_n, code) => {
    expect(await run(code, 1, code[0]!.trim().slice(0, 12), [1])).toBe(false);
  });

  it("does not confirm when the cited code was not changed", async () => {
    expect(await run(['  return db.query("SELECT * FROM users WHERE id = " + userId);'], 1, "db.query(", [7])).toBe(false);
  });

  it("does not confirm when the claim is about something else, or the category is not security", async () => {
    const code = ['  return db.query("SELECT * FROM users WHERE id = " + userId);'];
    expect(await run(code, 1, "db.query(", [1], "missing rate limiting on this endpoint")).toBe(false);
    expect(await run(code, 1, "db.query(", [1], undefined, { category: "code_quality" })).toBe(false);
  });

  it("does not confirm when the citation itself fails", async () => {
    const code = ['  return db.query("SELECT * FROM users WHERE id = " + userId);'];
    expect(await run(code, 1, "something that is not in the file", [1])).toBe(false);
  });
});

describe("detectConfirmation: removed authentication on a route", () => {
  const route = ['import { Router } from "express";', "const router = Router();", 'router.get("/admin", (req, res) => {', "  res.json(listUsers());", "});"];
  const removal = [
    "@@ -3,4 +3,3 @@", ' router.get("/admin", (req, res) => {', "-  if (!req.user.isAdmin) return res.status(403).end();", "   res.json(listUsers());", " });",
  ];
  const claim = "The admin check was removed so any user can list users";
  const base = (path: string, line = 4): Finding =>
    finding({ file: path, line, claim, evidence: "res.json(listUsers());" });

  it("confirms a removed admin check in a route file near the cited line", async () => {
    put("src/routes/admin.ts", route);
    expect(await detectConfirmation(base("src/routes/admin.ts"), ctx([entryFor("src/routes/admin.ts", removal)]))).toBe(true);
  });

  it("does not confirm when the check was only moved (an equal auth line was added)", async () => {
    put("src/routes/admin.ts", route);
    const moved = ["@@ -3,4 +3,4 @@", ...removal.slice(1, 3), "+  if (!req.user.isAdmin) return res.status(403).end();", ...removal.slice(3)];
    expect(await detectConfirmation(base("src/routes/admin.ts"), ctx([entryFor("src/routes/admin.ts", moved)]))).toBe(false);
  });

  it("does not confirm in a file that is not a route", async () => {
    put("src/util.ts", ["export const a = 1;", "export const b = 2;", "export const c = 3;", "export const d = 4;", "export const e = 5;"]);
    const f = finding({ file: "src/util.ts", line: 4, claim, evidence: "export const d = 4;" });
    expect(await detectConfirmation(f, ctx([entryFor("src/util.ts", removal)]))).toBe(false);
  });

  it("does not confirm when the cited line is far from the hunk", async () => {
    put("src/routes/admin.ts", [...route, ...Array.from({ length: 30 }, (_, i) => `// filler ${i}`)]);
    const far = finding({ file: "src/routes/admin.ts", line: 30, claim, evidence: "// filler 24" });
    expect(await detectConfirmation(far, ctx([entryFor("src/routes/admin.ts", removal)]))).toBe(false);
  });
});

describe("detectConfirmation: query or HTTP call in a loop", () => {
  const claim = "N+1: a query runs once per item inside the loop";
  const perf = (line: number, evidence: string): Finding => finding({ category: "performance", severity: "warning", line, claim, evidence });
  const changed = (n: number[]) => ({ ...entryFor("src/users.ts", ["@@ -0,0 +1,1 @@", "+x"]), addedLineNumbers: n }) as DiffEntry;

  it.each([
    ["for-of loop", ["async function f(ids) {", "  for (const id of ids) {", "    const u = await db.query(id);", "  }", "}"], 3, "db.query(id)"],
    ["forEach callback", ["ids.forEach(async (id) => {", "  await fetch(`/u/${id}`);", "});"], 2, "fetch("],
    ["one-line map", ["const all = ids.map((id) => db.findOne(id));"], 1, "db.findOne(id)"],
    ["python for loop", ["def f(ids):", "    for i in ids:", "        r = requests.get(url + i)"], 3, "requests.get("],
  ])("confirms a call inside a %s", async (_n, code, line, evidence) => {
    put("src/users.ts", code);
    expect(await detectConfirmation(perf(line, evidence), ctx([changed([line])]))).toBe(true);
  });

  it("does not confirm a call after the loop has closed, or in another function", async () => {
    put("src/users.ts", ["function a(ids) {", "  for (const id of ids) {", "    work(id);", "  }", "  return db.query(ids);", "}"]);
    expect(await detectConfirmation(perf(5, "db.query(ids)"), ctx([changed([5])]))).toBe(false);
    put("src/users.ts", ["for (const id of ids) {", "  work(id);", "}", "function b() {", "  return db.query(1);", "}"]);
    expect(await detectConfirmation(perf(5, "db.query(1)"), ctx([changed([5])]))).toBe(false);
  });

  it("does not confirm when the call was not changed, or the claim is not about a loop", async () => {
    put("src/users.ts", ["for (const id of ids) {", "  await db.query(id);", "}"]);
    expect(await detectConfirmation(perf(2, "db.query(id)"), ctx([changed([9])]))).toBe(false);
    expect(await detectConfirmation({ ...perf(2, "db.query(id)"), claim: "variable name is unclear" }, ctx([changed([2])]))).toBe(false);
  });
});

describe("detectConfirmation: never throws", () => {
  it("returns false for a missing file or a traversal path", async () => {
    expect(await detectConfirmation(finding({ file: "nope.ts" }), ctx([]))).toBe(false);
    expect(await detectConfirmation(finding({ file: "../../etc/passwd" }), ctx([]))).toBe(false);
  });
});
