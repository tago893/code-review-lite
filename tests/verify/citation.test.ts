import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeResolve, verifyCitation } from "../../src/verify/citation.js";
import type { DiffEntry, Finding } from "../../src/types.js";

let base = "";
let root = "";
let outside = "";

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cit-"));
  root = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside secret line\n");
  writeFileSync(join(root, "src/users.ts"), ["import db from './db';", "", "export function getUser(userId: string) {", '  return db.query("SELECT * FROM users WHERE id = " + userId);', "}", ""].join("\n"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1", category: "security", severity: "warning", file: "src/users.ts", line: 4,
  evidence: 'db.query("SELECT * FROM users WHERE id = " + userId);', claim: "c", path: "p", reviewer: "r", ...over,
});

const entry = (path: string, added: number[]): DiffEntry => ({
  oldPath: path, newPath: path, status: "modified", addedLines: added.map(() => "x"), removedLines: [],
  addedLineNumbers: added, removedLineNumbers: [], isBinary: false, isRename: false, patch: "",
});

const ctx = (entries: readonly DiffEntry[] = []) => ({ repoRoot: root, entries });

describe("safeResolve", () => {
  it("resolves a normal file to its real path", async () => {
    expect(await safeResolve(root, "src/users.ts")).toMatch(/src\/users\.ts$/);
  });

  it.each([
    ["parent traversal", "../outside/secret.txt"],
    ["deep traversal", "../../etc/passwd"],
    ["traversal hidden mid-path", "src/../../outside/secret.txt"],
    ["absolute path", "/etc/passwd"],
    ["NUL byte", "src/users.ts\0.png"],
    ["empty", ""],
    ["missing file", "src/nope.ts"],
  ])("throws for %s", async (_name, rel) => {
    await expect(safeResolve(root, rel)).rejects.toThrow();
  });

  it("throws for a symlinked file whose target is outside the root", async () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src/link.txt"));
    await expect(safeResolve(root, "src/link.txt")).rejects.toThrow();
  });

  it("throws for a file reached through a symlinked directory pointing outside", async () => {
    symlinkSync(outside, join(root, "linkdir"));
    await expect(safeResolve(root, "linkdir/secret.txt")).rejects.toThrow();
  });

  it("uses fixed messages that never contain the requested path", async () => {
    const error = await safeResolve(root, "../outside/secret.txt").catch((e: Error) => e);
    expect((error as Error).message).not.toContain("secret.txt");
  });
});

describe("verifyCitation", () => {
  it("passes when file, line and evidence match", async () => {
    expect(await verifyCitation(finding(), ctx())).toEqual({ ok: true, touchesChangedLine: false });
  });

  it("allows the evidence to sit within 3 lines of the cited line, not 4", async () => {
    expect((await verifyCitation(finding({ line: 1 }), ctx())).ok).toBe(true);
    const far = await verifyCitation(finding({ line: 8 }), ctx());
    expect(far.ok).toBe(false);
    writeFileSync(join(root, "src/long.ts"), ["a", "b", "c", "d", "e", "needle", "g"].join("\n"));
    expect((await verifyCitation(finding({ file: "src/long.ts", line: 2, evidence: "needle" }), ctx())).ok).toBe(false);
    expect((await verifyCitation(finding({ file: "src/long.ts", line: 3, evidence: "needle" }), ctx())).ok).toBe(true);
  });

  it.each([
    ["missing file", { file: "src/missing.ts" }],
    ["line out of range", { line: 9999 }],
    ["line zero", { line: 0 }],
    ["evidence not in the file", { evidence: "eval(userInput)" }],
    ["traversal", { file: "../../etc/passwd" }],
    ["absolute path", { file: "/etc/passwd" }],
    ["directory", { file: "src" }],
    ["empty evidence", { evidence: "   " }],
  ])("fails for %s", async (_name, over) => {
    const result = await verifyCitation(finding(over), ctx());
    expect(result.ok).toBe(false);
    expect(result.touchesChangedLine).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("fails for a symlink to a file outside the root and for a symlinked directory", async () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src/link.txt"));
    symlinkSync(outside, join(root, "linkdir"));
    const a = await verifyCitation(finding({ file: "src/link.txt", line: 1, evidence: "outside secret line" }), ctx());
    const b = await verifyCitation(finding({ file: "linkdir/secret.txt", line: 1, evidence: "outside secret line" }), ctx());
    expect([a.ok, b.ok]).toEqual([false, false]);
  });

  it("does not put the finding's text in the failure reason", async () => {
    const result = await verifyCitation(finding({ evidence: "SENTINEL_TEXT_123" }), ctx());
    expect(result.reason).not.toContain("SENTINEL_TEXT_123");
  });

  it("matches CRLF files, multi-line evidence and different indentation", async () => {
    writeFileSync(join(root, "src/crlf.ts"), "function f() {\r\n    if (x) {\r\n        run();\r\n    }\r\n}\r\n");
    const multi = finding({ file: "src/crlf.ts", line: 2, evidence: "if (x) {\n  run();\n}" });
    expect((await verifyCitation(multi, ctx())).ok).toBe(true);
  });

  it("matches a file with a final line that has no newline", async () => {
    writeFileSync(join(root, "src/tail.ts"), "a\nlast line");
    expect((await verifyCitation(finding({ file: "src/tail.ts", line: 2, evidence: "last line" }), ctx())).ok).toBe(true);
  });

  it("rejects files that are too large to verify", async () => {
    writeFileSync(join(root, "src/huge.ts"), "x".repeat(3_000_000));
    expect((await verifyCitation(finding({ file: "src/huge.ts", line: 1, evidence: "x" }), ctx())).ok).toBe(false);
  });
});

describe("verifyCitation: touchesChangedLine", () => {
  it("is true when the cited line is an added line of the matching entry", async () => {
    const result = await verifyCitation(finding(), ctx([entry("src/users.ts", [4])]));
    expect(result).toEqual({ ok: true, touchesChangedLine: true });
  });

  it("is false for untouched code, for another file's entry and for a different line", async () => {
    expect((await verifyCitation(finding(), ctx([entry("src/users.ts", [1, 2])]))).touchesChangedLine).toBe(false);
    expect((await verifyCitation(finding(), ctx([entry("src/other.ts", [4])]))).touchesChangedLine).toBe(false);
    expect((await verifyCitation(finding(), ctx())).touchesChangedLine).toBe(false);
  });

  it("is true when the evidence lies on a changed line that is not the cited line", async () => {
    const result = await verifyCitation(finding({ line: 3 }), ctx([entry("src/users.ts", [4])]));
    expect(result).toEqual({ ok: true, touchesChangedLine: true });
  });

  it("is true when a multi-line evidence span overlaps an added line", async () => {
    const multi = finding({ line: 3, evidence: "export function getUser(userId: string) {\n  return db.query(" });
    expect((await verifyCitation(multi, ctx([entry("src/users.ts", [4])]))).touchesChangedLine).toBe(true);
  });
});
