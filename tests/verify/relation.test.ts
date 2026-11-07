import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { changedSymbols, linkedSymbols } from "../../src/verify/relation.js";

const count = (body: string[], marks: string[]): number => body.filter((l) => marks.includes(l[0] ?? "")).length;
const diff = (body: string[], context = ""): string =>
  ["diff --git a/src/lib.ts b/src/lib.ts", "index 1111111..2222222 100644", "--- a/src/lib.ts", "+++ b/src/lib.ts",
    `@@ -1,${count(body, ["-", " "])} +1,${count(body, ["+", " "])} @@${context}`, ...body, ""].join("\n");

describe("changedSymbols", () => {
  it("collects names declared on added or removed lines", () => {
    const symbols = changedSymbols(parseUnifiedDiff(diff(["-export function scale(v: number) {", "+export function scale(v: number, f: number) {", "+const helper = 1;", " }"])));
    expect([...symbols].sort()).toEqual(["helper", "scale"]);
  });

  it("collects the function a changed hunk sits in, from the @@ context", () => {
    const symbols = changedSymbols(parseUnifiedDiff(diff([" a", "-return 1;", "+return 2;", " b"], " export function compute(x) {")));
    expect(symbols.has("compute")).toBe(true);
  });

  it("collects method signatures and ignores control-flow keywords", () => {
    const symbols = changedSymbols(parseUnifiedDiff(diff(["+  render(props) {", "+  if (x) {", "+  while (y) {"])));
    expect(symbols.has("render")).toBe(true);
    expect(symbols.has("if")).toBe(false);
    expect(symbols.has("while")).toBe(false);
  });
});

describe("linkedSymbols", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rel-")); mkdirSync(join(root, "src")); writeFileSync(join(root, "src/c.ts"), "const a = 1;\nconst r = scale(10);\n"); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns the changed symbols the cited line mentions, and nothing for an unrelated line", async () => {
    const symbols = new Set(["scale", "helper"]);
    expect(await linkedSymbols(root, "src/c.ts", 2, symbols)).toEqual(["scale"]);
    expect(await linkedSymbols(root, "src/c.ts", 1, symbols)).toEqual([]);
  });

  it("treats an unreadable file or out-of-range line as not linked", async () => {
    const symbols = new Set(["scale"]);
    expect(await linkedSymbols(root, "src/missing.ts", 1, symbols)).toEqual([]);
    expect(await linkedSymbols(root, "src/c.ts", 99, symbols)).toEqual([]);
  });
});
