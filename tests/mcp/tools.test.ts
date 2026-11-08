import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/mcp/limits.js";
import { ToolError, type Roots } from "../../src/mcp/paths.js";
import { globTool, grepTool, listTool, readTool } from "../../src/mcp/tools.js";

let base = "";
let repo = "";
let ctx = "";
let outside = "";
let roots: Roots;

const put = (root: string, rel: string, content: string | Buffer): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const numbered = (n: number, prefix = "line"): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
const code = (fn: () => unknown): Promise<string> =>
  Promise.resolve().then(fn).then(() => "no error", (e: unknown) => (e instanceof ToolError ? e.code : `other:${String(e)}`));

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mcp-"));
  repo = join(base, "repo");
  ctx = join(base, "ctx");
  outside = join(base, "outside");
  for (const d of [repo, ctx, outside]) mkdirSync(d);
  roots = { primary: repo, extra: [ctx] };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("read: bounded chunks with real line numbers", () => {
  it("never returns a whole large file by default and says how to continue", () => {
    put(repo, "src/big.ts", numbered(400));
    const out = readTool(roots, { path: "src/big.ts" });
    expect(out).toContain("src/big.ts (lines 1-100 of 400)");
    expect(out).toContain("100: line 100");
    expect(out).not.toContain("101: line 101");
    expect(out).toContain('[TRUNCATED: 300 more lines not shown. Call read again with path="src/big.ts" offset=101]');
  });

  it("continues from the offset it gave, keeping the original line numbers, until the end", () => {
    put(repo, "src/big.ts", numbered(250));
    const first = readTool(roots, { path: "src/big.ts" });
    expect(first).toContain("offset=101");
    const second = readTool(roots, { path: "src/big.ts", offset: 101 });
    expect(second).toContain("101: line 101");
    expect(second).toContain("200: line 200");
    const third = readTool(roots, { path: "src/big.ts", offset: 201 });
    expect(third).toContain("src/big.ts (lines 201-250 of 250)");
    expect(third).toContain("250: line 250");
    expect(third).toContain("[END OF FILE]");
  });

  it("caps the line count at the maximum however many are asked for, and the bytes at the byte limit", () => {
    put(repo, "wide.txt", Array.from({ length: 500 }, (_, i) => `${i + 1} ${"x".repeat(80)}`).join("\n"));
    const out = readTool(roots, { path: "wide.txt", limit: 100000 });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LIMITS.maxReadBytes + 400);
    expect(out).toMatch(/\[TRUNCATED: \d+ more lines not shown\. Call read again with path="wide\.txt" offset=\d+\]/);
    const shown = out.split("\n").filter((l) => /^\d+: /.test(l)).length;
    expect(shown).toBeLessThanOrEqual(LIMITS.maxReadLines);
  });

  it("clips a very long line and marks it", () => {
    put(repo, "min.js", `${"a".repeat(5000)}\nshort\n`);
    const out = readTool(roots, { path: "min.js" });
    expect(out).toContain("…[line truncated, 5000 chars]");
    expect(out).toContain("2: short");
    expect(Buffer.byteLength(out)).toBeLessThan(1000);
  });

  it("refuses binary files, oversized files, directories and offsets past the end", async () => {
    put(repo, "a.bin", Buffer.from([1, 2, 0, 3, 4]));
    put(repo, "huge.txt", "x".repeat(LIMITS.maxFileBytes + 1));
    put(repo, "src/a.ts", "one\n");
    expect(await code(() => readTool(roots, { path: "a.bin" }))).toBe("binary");
    expect(await code(() => readTool(roots, { path: "huge.txt" }))).toBe("too_large");
    expect(await code(() => readTool(roots, { path: "src" }))).toBe("not_a_file");
    expect(await code(() => readTool(roots, { path: "src/a.ts", offset: 50 }))).toBe("offset_past_end");
    expect(await code(() => readTool(roots, { path: "missing.ts" }))).toBe("not_found");
  });

  it("reads by absolute path under the repository and under the review context, but relative paths mean the repository", () => {
    put(repo, "src/a.ts", "export const a = 1;\n");
    put(ctx, "patches/a.patch", "@@ -1 +1 @@\n-old\n+new\n");
    expect(readTool(roots, { path: join(repo, "src/a.ts") })).toContain("1: export const a = 1;");
    expect(readTool(roots, { path: join(ctx, "patches/a.patch") })).toContain("2: -old");
    expect(readTool(roots, { path: "src/a.ts" })).toContain("src/a.ts (lines 1-1 of 1)");
  });

  it("rejects bad arguments with a content-free error", async () => {
    expect(await code(() => readTool(roots, { path: "" }))).toContain("other:");
    expect(() => readTool(roots, { path: "a", offset: 0 })).toThrow();
    expect(() => readTool(roots, { path: "a", limit: 1.5 })).toThrow();
    expect(() => readTool(roots, {})).toThrow();
  });
});

describe("path containment", () => {
  beforeEach(() => {
    put(repo, "src/a.ts", "inside\n");
    put(outside, "secret.txt", "TOP-SECRET\n");
  });

  it("rejects traversal and absolute paths outside the roots", async () => {
    for (const path of ["../outside/secret.txt", "src/../../outside/secret.txt", join(outside, "secret.txt"), "/etc/passwd", "/", "//etc/passwd"]) {
      expect(await code(() => readTool(roots, { path })), path).toBe("outside_roots");
    }
    expect(await code(() => listTool(roots, { path: ".." }))).toBe("outside_roots");
    expect(await code(() => grepTool(roots, { pattern: "x", path: "../outside" }))).toBe("outside_roots");
  });

  it("rejects a symlink to a file outside the root, to a directory outside, and to a file inside", async () => {
    symlinkSync(join(outside, "secret.txt"), join(repo, "link-file"));
    symlinkSync(outside, join(repo, "link-dir"));
    symlinkSync(join(repo, "src/a.ts"), join(repo, "link-inside"));
    expect(await code(() => readTool(roots, { path: "link-file" }))).toBe("symlink");
    expect(await code(() => readTool(roots, { path: "link-dir/secret.txt" }))).toBe("symlink");
    expect(await code(() => listTool(roots, { path: "link-dir" }))).toBe("symlink");
    expect(await code(() => readTool(roots, { path: "link-inside" }))).toBe("symlink");
  });

  it("rejects NUL bytes, over-long paths and withheld names", async () => {
    put(repo, ".env", "TOKEN=x\n");
    put(repo, "keys/id_rsa", "k\n");
    expect(await code(() => readTool(roots, { path: "src/a.ts\0.txt" }))).toBe("bad_path");
    expect(await code(() => readTool(roots, { path: "a".repeat(LIMITS.maxPathChars + 1) }))).toContain("other:");
    expect(await code(() => readTool(roots, { path: ".env" }))).toBe("withheld");
    expect(await code(() => readTool(roots, { path: "keys/id_rsa" }))).toBe("withheld");
  });

  it("does not treat a sibling directory that merely shares the root's name prefix as inside it", async () => {
    mkdirSync(join(base, "repo-evil"));
    put(base, "repo-evil/x.txt", "x");
    expect(await code(() => readTool(roots, { path: join(base, "repo-evil/x.txt") }))).toBe("outside_roots");
    expect(await code(() => readTool(roots, { path: "../repo-evil/x.txt" }))).toBe("outside_roots");
  });
});

describe("grep: cross-file, bounded", () => {
  beforeEach(() => {
    put(repo, "src/users.ts", "export function findUser(name: string) {\n  return query(name);\n}\n");
    put(repo, "src/server.ts", "import { findUser } from './users';\nexport const route = (q: string) => findUser(q);\n");
    put(repo, "src/other.ts", "const unrelated = 1;\n");
    put(repo, "node_modules/dep/index.js", "findUser();\n");
  });

  it("finds an unchanged consumer in another file and reports path:line: text", async () => {
    const out = await grepTool(roots, { pattern: "findUser" });
    expect(out).toContain("src/server.ts:1: import { findUser } from './users';");
    expect(out).toContain("src/server.ts:2: export const route = (q: string) => findUser(q);");
    expect(out).toContain("src/users.ts:1: export function findUser");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("[TRUNCATED");
  });

  it("scopes to a file or directory and to an include glob; literal matches regex characters", async () => {
    expect(await grepTool(roots, { pattern: "findUser", path: "src/server.ts" })).toMatch(/^2 match\(es\)[^\n]*\nsrc\/server\.ts:1:/);
    put(repo, "src/sub/x.ts", "a.b(c)\n");
    expect(await grepTool(roots, { pattern: "a.b(c)", literal: true, path: "src/sub" })).toContain("src/sub/x.ts:1: a.b(c)");
    expect(await grepTool(roots, { pattern: "findUser", include: "users.ts" })).not.toContain("server.ts");
  });

  it("caps the number of matches and says so", async () => {
    put(repo, "src/many.ts", Array.from({ length: 200 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    put(repo, "src/many2.ts", Array.from({ length: 200 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    put(repo, "src/many3.ts", Array.from({ length: 200 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    put(repo, "src/many4.ts", Array.from({ length: 200 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    put(repo, "src/many5.ts", Array.from({ length: 200 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    const out = await grepTool(roots, { pattern: "hit" });
    expect(out.split("\n").filter((l) => /^src\/.+:\d+: hit/.test(l)).length).toBeLessThanOrEqual(LIMITS.maxGrepMatches);
    expect(out).toContain("[TRUNCATED");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(LIMITS.maxGrepBytes + 300);
  });

  it("truncates very long matching lines instead of returning them whole", async () => {
    put(repo, "src/min.js", `needle ${"z".repeat(10000)}\n`);
    const out = await grepTool(roots, { pattern: "needle", path: "src/min.js" });
    expect(Buffer.byteLength(out)).toBeLessThan(1200);
  });

  it("skips files over the size limit", async () => {
    put(repo, "src/huge.txt", `needle\n${"x".repeat(LIMITS.maxGrepFileBytes + 10)}`);
    expect(await grepTool(roots, { pattern: "needle", path: "src" })).not.toContain("huge.txt");
  });

  it("does not follow symlinks out of the snapshot", async () => {
    put(outside, "secret.txt", "needle-outside\n");
    symlinkSync(outside, join(repo, "src/escape"));
    symlinkSync(join(outside, "secret.txt"), join(repo, "src/escape.txt"));
    const out = await grepTool(roots, { pattern: "needle-outside" });
    expect(out).not.toContain("needle-outside\n");
    expect(out).toMatch(/^0 match/);
  });

  it("treats a pattern that starts with a dash as a pattern, not an option, and reports an invalid regex", async () => {
    put(repo, "src/flags.ts", "--files --hidden\n");
    expect(await grepTool(roots, { pattern: "--files", path: "src/flags.ts" })).toContain("src/flags.ts:1: --files --hidden");
    expect(await code(() => grepTool(roots, { pattern: "(unclosed" }))).toBe("bad_pattern");
  });

  it("returns 0 matches cleanly and stays bounded on a pathological regex (linear-time engine)", async () => {
    put(repo, "src/evil.ts", `${"a".repeat(30)}!\n`);
    const started = Date.now();
    const out = await grepTool(roots, { pattern: "(a+)+$", path: "src/evil.ts" });
    expect(Date.now() - started).toBeLessThan(LIMITS.grepTimeoutMs + 1000);
    expect(out).toContain("match");
    expect(await grepTool(roots, { pattern: "zzzz-not-there" })).toMatch(/^0 match\(es\)/);
  });
});

describe("glob and list", () => {
  beforeEach(() => {
    put(repo, "src/a.ts", "a\n");
    put(repo, "src/b.ts", "b\n");
    put(repo, "src/deep/c.ts", "c\n");
    put(repo, "README.md", "r\n");
    put(repo, "node_modules/x/index.ts", "x\n");
  });

  it("globs files by pattern, relative to the snapshot, without node_modules", async () => {
    const out = await globTool(roots, { pattern: "**/*.ts" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/deep/c.ts");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("README.md");
  });

  it("caps glob results", async () => {
    for (let i = 0; i < 150; i++) put(repo, `gen/f${String(i).padStart(3, "0")}.ts`, "x\n");
    const out = await globTool(roots, { pattern: "gen/*.ts" });
    expect(out.split("\n").filter((l) => l.startsWith("gen/")).length).toBeLessThanOrEqual(LIMITS.maxGlobResults);
    expect(out).toContain("[TRUNCATED");
  });

  it("lists one level, directories first, no symlinks", async () => {
    symlinkSync(outside, join(repo, "link"));
    const out = listTool(roots, {});
    const lines = out.split("\n");
    expect(lines[0]).toBe("./");
    expect(lines.slice(1)).toEqual(["node_modules/", "src/", "README.md"]);
    expect(out).not.toContain("link");
    expect(await code(() => listTool(roots, { path: "README.md" }))).toBe("not_a_directory");
  });

  it("caps a directory listing", () => {
    for (let i = 0; i < 160; i++) put(repo, `many/f${i}.txt`, "x");
    const out = listTool(roots, { path: "many" });
    expect(out).toContain("[TRUNCATED");
    expect(out.split("\n").length).toBeLessThanOrEqual(LIMITS.maxListEntries + 3);
  });
});
