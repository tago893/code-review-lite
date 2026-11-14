import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planReview } from "../../src/plan.js";
import type { DiffEntry } from "../../src/types.js";
import { buildChangeMap, renderChangeMap, type ChangeMap } from "../../src/workspace/change-map.js";

const FIXTURE = resolve("tests/fixtures/change-map");
const HOLD = "app/services/hold_service.py";
const CASE_FILES = [HOLD, "app/services/booking_service.py", "app/api/routes_holds.py", "tests/test_hold_durability.py"];

const entriesOf = (diff: string): readonly DiffEntry[] => {
  const p = planReview(diff);
  if (!p.ok) throw new Error("plan failed");
  return p.plan.entries;
};
const header = (path: string): string[] => [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`];
/** A one-hunk modify diff that replaces `before` with `after` wholesale. */
const modify = (path: string, before: string[], after: string[]): string =>
  [...header(path), `@@ -1,${before.length} +1,${after.length} @@`, ...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`), ""].join("\n");

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cm-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

describe("change map: Case 001", () => {
  it("finds the changed function and its callers, not definitions or tests", async () => {
    const entries = entriesOf(readFileSync(join(FIXTURE, "case001.diff"), "utf8"));
    const map = await buildChangeMap(join(FIXTURE, "case001"), entries, CASE_FILES);
    const getHold = map.functions.find((f) => f.span.name === "get_hold")!;
    expect(getHold.path).toBe(HOLD);
    expect(getHold.span).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
    expect(getHold.changedLines).toEqual([91, 92, 93, 94, 95, 97, 98, 99, 100, 101, 102]);
    expect(getHold.callers.map((c) => [c.path, c.line, c.caller])).toEqual([
      ["app/services/booking_service.py", 29, { name: "confirm", startLine: 28, endLine: 51 }],
      [HOLD, 124, { name: "_require_active", startLine: 123, endLine: 127 }],
    ]);
    expect(getHold.callers[0]!.slice).toMatchObject({ startLine: 28, endLine: 51 });
    expect(getHold.callers[0]!.slice.text).toContain("self._holds.get_hold(hold_id)");
    expect(map.functions.some((f) => f.path.startsWith("tests/"))).toBe(false);
    expect(Object.isFrozen(map)).toBe(true);
  });
});

describe("change map: edge cases", () => {
  it("attributes a removal-only change to the function around it", async () => {
    put("m.py", ["def alpha():", "    a = 1", "    b = 2", "    return a", "", "def beta():", "    return 1", ""].join("\n"));
    const diff = [...header("m.py"), "@@ -2,4 +2,3 @@", "     a = 1", "-    gone = 0", "     b = 2", "     return a", ""].join("\n");
    const map = await buildChangeMap(dir, entriesOf(diff), ["m.py"]);
    expect(map.functions).toHaveLength(1);
    expect(map.functions[0]!.span).toEqual({ name: "alpha", startLine: 1, endLine: 4 });
    expect(map.functions[0]!.changedLines).toEqual([2]);
  });

  it("caps callers at 5, non-test first, then by path and line", async () => {
    put("lib.py", ["def compute(x):", "    return x + 1", ""].join("\n"));
    const caller = (n: number): string => `def use${n}():\n    return compute(${n})\n`;
    put("a.py", caller(1) + caller(2));
    put("b.py", caller(3) + caller(4) + caller(5));
    put("tests/test_a.py", caller(6));
    put("tests/test_b.py", caller(7));
    const diff = modify("lib.py", ["def compute(x):", "    return x"], ["def compute(x):", "    return x + 1"]);
    const files = ["lib.py", "a.py", "b.py", "tests/test_a.py", "tests/test_b.py"];
    const fn = (await buildChangeMap(dir, entriesOf(diff), files)).functions[0]!;
    expect(fn.callersSearched).toBe(true);
    expect(fn.callers).toHaveLength(5);
    expect(fn.moreCallers).toBe(2);
    expect(fn.callers.map((c) => [c.path, c.line])).toEqual([["a.py", 2], ["a.py", 4], ["b.py", 2], ["b.py", 4], ["b.py", 6]]);
  });

  it("does not search callers for dunder or very short names", async () => {
    put("k.py", ["class K:", "    def __init__(self):", "        self.a = 2", ""].join("\n"));
    put("u.py", "K()\nx = __init__(1)\n");
    const d1 = modify("k.py", ["class K:", "    def __init__(self):", "        self.a = 1"], ["class K:", "    def __init__(self):", "        self.a = 2"]);
    const init = (await buildChangeMap(dir, entriesOf(d1), ["k.py", "u.py"])).functions.find((f) => f.span.name === "__init__")!;
    expect(init.callersSearched).toBe(false);
    expect(init.callers).toEqual([]);

    put("s.py", ["def ab():", "    return 2", "", "ab()", ""].join("\n"));
    const d2 = modify("s.py", ["def ab():", "    return 1"], ["def ab():", "    return 2"]);
    const short = (await buildChangeMap(dir, entriesOf(d2), ["s.py"])).functions[0]!;
    expect(short.callersSearched).toBe(false);
    expect(short.callers).toEqual([]);
  });

  it("skips entries whose file is missing from the snapshot", async () => {
    const diff = modify("gone.py", ["def f():", "    return 1"], ["def f():", "    return 2"]);
    const map = await buildChangeMap(dir, entriesOf(diff), ["gone.py"]);
    expect(map.functions).toEqual([]);
  });

  it("finds callers of a JS function named with a dollar sign", async () => {
    put("a.js", ["function $get(id) {", "  return id + 1;", "}", ""].join("\n"));
    put("b.js", ["function run() {", "  return $get(1);", "}", ""].join("\n"));
    const diff = modify("a.js", ["function $get(id) {", "  return id;", "}"], ["function $get(id) {", "  return id + 1;", "}"]);
    const fn = (await buildChangeMap(dir, entriesOf(diff), ["a.js", "b.js"])).functions[0]!;
    expect(fn.callers.map((c) => [c.path, c.line])).toEqual([["b.js", 2]]);
  });

  it("skips deleted and binary entries without throwing", async () => {
    put("d.py", "def f():\n    return 1\n");
    const base = entriesOf(modify("d.py", ["def f():", "    return 0"], ["def f():", "    return 1"]))[0]!;
    const entries: DiffEntry[] = [{ ...base, status: "deleted" }, { ...base, isBinary: true }];
    const map = await buildChangeMap(dir, entries, ["d.py"]);
    expect(map.functions).toEqual([]);
  });

  it("does not count a recursive call inside the changed function as a caller", async () => {
    put("r.py", ["def walk(n):", "    if n:", "        return walk(n - 1)", "    return 0", ""].join("\n"));
    const before = ["def walk(n):", "    if n:", "        return walk(n - 2)", "    return 0"];
    const after = ["def walk(n):", "    if n:", "        return walk(n - 1)", "    return 0"];
    const fn = (await buildChangeMap(dir, entriesOf(modify("r.py", before, after)), ["r.py"])).functions[0]!;
    expect(fn.callers).toEqual([]);
  });

  it("windows the slice around the call when the caller is longer than 40 lines", async () => {
    const filler = Array.from({ length: 58 }, (_, i) => `    x${i} = ${i}`);
    put("big.py", ["def big():", ...filler.slice(0, 29), "    compute(1)", ...filler.slice(29), ""].join("\n"));
    put("lib.py", ["def compute(x):", "    return x", ""].join("\n"));
    const diff = modify("lib.py", ["def compute(x):", "    return 0"], ["def compute(x):", "    return x"]);
    const call = (await buildChangeMap(dir, entriesOf(diff), ["lib.py", "big.py"])).functions[0]!.callers[0]!;
    expect(call.line).toBe(31);
    expect(call.caller).toMatchObject({ name: "big", startLine: 1, endLine: 60 });
    expect(call.slice).toMatchObject({ startLine: 26, endLine: 36 });
    expect(call.slice.text.split("\n")).toHaveLength(11);
  });

  it("gives the same spans and callers for CRLF files", async () => {
    const src = readFileSync(join(FIXTURE, "case001", HOLD), "utf8").replace(/\r?\n/g, "\r\n");
    put(HOLD, src);
    const only = entriesOf(readFileSync(join(FIXTURE, "case001.diff"), "utf8")).filter((e) => e.newPath === HOLD);
    const map = await buildChangeMap(dir, only, [HOLD]);
    const getHold = map.functions.find((f) => f.span.name === "get_hold")!;
    expect(getHold.span).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
    expect(getHold.callers.map((c) => [c.path, c.line, c.caller])).toEqual([
      [HOLD, 124, { name: "_require_active", startLine: 123, endLine: 127 }],
    ]);
  });
});

describe("renderChangeMap", () => {
  const case001 = async (): Promise<ChangeMap> =>
    buildChangeMap(join(FIXTURE, "case001"), entriesOf(readFileSync(join(FIXTURE, "case001.diff"), "utf8")), CASE_FILES);

  it("renders the index first, then numbered caller code", async () => {
    const text = renderChangeMap(await case001());
    expect(text.startsWith("Changed functions and who calls them (found by text search before the review; a caller may be missing or unrelated):\n")).toBe(true);
    expect(text).toContain("- app/services/hold_service.py:90-102 get_hold (changed lines 91-95, 97-102)\n");
    expect(text).toContain("  - called at app/services/booking_service.py:29 in confirm (lines 28-51)\n");
    expect(text).toContain("  - called at app/services/hold_service.py:124 in _require_active (lines 123-127)\n");
    expect(text).toContain("\nCaller code:\n--- app/services/booking_service.py:28-51 (confirm) ---\n");
    expect(text).toContain("   29          hold = self._holds.get_hold(hold_id)\n");
    expect(text.indexOf("Caller code:")).toBeGreaterThan(text.lastIndexOf("  - called at"));
  });

  it("renders nothing for an empty map", () => {
    expect(renderChangeMap({ functions: [], omittedFunctions: 0, unreadableFiles: 0 })).toBe("");
  });

  it("keeps the index and drops caller slices that do not fit", async () => {
    const full = await case001();
    const short = renderChangeMap(full, 400);
    expect(short.length).toBeLessThanOrEqual(400 + 120);
    expect(short).toContain("- app/services/hold_service.py:90-102 get_hold");
    expect(short).toContain("caller slices omitted for length; read them with cra_read]");
    expect(renderChangeMap(full)).not.toContain("omitted for length");
  });

  it("says when callers were capped, not searched, or functions omitted", () => {
    const span = { name: "go", startLine: 1, endLine: 2 };
    const map: ChangeMap = {
      functions: [{ path: "a.py", span, changedLines: [2], callersSearched: false, callers: [], moreCallers: 0 },
        { path: "b.py", span, changedLines: [1, 2, 4], callersSearched: true, callers: [], moreCallers: 3 }],
      omittedFunctions: 2, unreadableFiles: 0,
    };
    const text = renderChangeMap(map);
    expect(text).toContain("  [callers not searched: name too short or special]\n");
    expect(text).toContain("  [3 more callers not listed]\n");
    expect(text).toContain("(changed lines 1-2, 4)");
    expect(text).toContain("[2 more changed functions not listed]\n");
    expect(text).not.toContain("Caller code:");
  });
});
