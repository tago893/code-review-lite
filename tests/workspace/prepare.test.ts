import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactSecretsDetailed } from "../../src/safety/redact.js";
import { prepareWorkspace } from "../../src/workspace/prepare.js";
import { fake, filler } from "../safety/fakes.js";

let base = "";
let raw = "";
let out = "";
const secret = fake.password();
const key = fake.groq();

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ws-"));
  raw = join(base, "raw");
  out = join(base, "out");
  mkdirSync(raw);
  mkdirSync(out);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (rel: string, content: string | Buffer): void => {
  const full = join(raw, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

function walk(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    found.push(full);
    if (lstatSync(full).isDirectory()) walk(full, found);
  }
  return found;
}

const relOut = (): string[] => walk(out).map((p) => p.slice(out.length + 1)).sort();

describe("prepareWorkspace: copying and redaction", () => {
  it("copies text files, redacts secrets in place and keeps every line number", async () => {
    put("src/app.ts", `// header\nconst password = "${secret}";\nconst key = "${key}";\nexport {};\n`);
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(result.status).toBe("ready");
    const copy = readFileSync(join(out, "src/app.ts"), "utf8").split("\n");
    expect(copy).toEqual(['// header', 'const password = "[REDACTED]";', 'const key = "[REDACTED]";', "export {};", ""]);
  });

  it("keeps CRLF line endings, a BOM and the absence of a final newline", async () => {
    put("a.txt", Buffer.from("﻿one\r\ntwo", "utf8"));
    await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(readFileSync(join(out, "a.txt"))).toEqual(Buffer.from("﻿one\r\ntwo", "utf8"));
  });

  it("keeps nested paths and names with spaces", async () => {
    put("a/b/c d/e f.ts", "const x = 1;\n");
    await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(readFileSync(join(out, "a/b/c d/e f.ts"), "utf8")).toBe("const x = 1;\n");
  });

  it("leaves no copy of any secret anywhere under the output, manifest included", async () => {
    put("src/a.ts", `const password = "${secret}";\n`);
    put("src/b.ts", `x = "${key}"\n`);
    put("src/cert.pem", `${fake.pemHeader()}\n${filler(60)}\n${fake.pemFooter()}\n`);
    put(".env", `API_TOKEN=${filler(30)}\n`);
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    const everything = walk(out).filter((p) => statSync(p).isFile()).map((p) => readFileSync(p, "utf8")).join("\n");
    for (const value of [secret, key, filler(60), filler(30)]) {
      expect(everything).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it("reports redaction counts per file without values", async () => {
    put("src/a.ts", `const password = "${secret}";\n`);
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.copied).toEqual([{ path: "src/a.ts", lines: 2, redactions: 1 }]);
  });

  it("gives copied files mode 0644 regardless of the source mode", async () => {
    put("run.sh", "#!/bin/sh\n");
    execFileSync("chmod", ["777", join(raw, "run.sh")]);
    await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(statSync(join(out, "run.sh")).mode & 0o777).toBe(0o644);
  });
});

describe("prepareWorkspace: what never gets in", () => {
  it("excludes .git, env files, keys and credentials but keeps env templates", async () => {
    put(".git/config", `[remote]\n\turl = https://u:${secret}@example.com/r.git\n`);
    put(".git/objects/aa/bb", "history");
    put(".env", `TOKEN=${filler(30)}\n`);
    put(".env.production", "X=1\n");
    put(".env.example", "TOKEN=\n");
    put("deploy/id_rsa", "k");
    put("deploy/server.key", "k");
    put("node_modules/lib/index.js", "x");
    put("sub/.git", "gitdir: ../.git/modules/sub\n");
    put("src/ok.ts", "ok\n");
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(relOut()).toEqual([".env.example", "src", "src/ok.ts"]);
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.skipped.map((s) => s.reason)).toContain("sensitive");
  });

  it("copies no symlink and never follows one", async () => {
    put("src/real.ts", "real\n");
    symlinkSync("/etc", join(raw, "src/to_etc"));
    symlinkSync("/etc/hostname", join(raw, "src/to_file"));
    symlinkSync("real.ts", join(raw, "src/inside"));
    symlinkSync("../../nowhere", join(raw, "src/dangling"));
    symlinkSync("..", join(raw, "src/up"));
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(relOut()).toEqual(["src", "src/real.ts"]);
    expect(walk(out).some((p) => lstatSync(p).isSymbolicLink())).toBe(false);
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.skipped.filter((s) => s.reason === "symlink")).toHaveLength(5);
  });

  it("skips unsupported file types", async () => {
    put("src/ok.ts", "ok\n");
    execFileSync("mkfifo", [join(raw, "src/pipe")]);
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    expect(relOut()).toEqual(["src", "src/ok.ts"]);
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.skipped).toContainEqual({ path: "src/pipe", reason: "unsupported_type" });
  });

  it("skips binary, non-UTF-8 and oversized files and records why", async () => {
    put("img.bin", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    put("latin.txt", Buffer.from([0x63, 0xe9, 0xe9]));
    put("big.txt", "x".repeat(2000));
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out, maxFileBytes: 1000 });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]))).toEqual({
      "img.bin": "binary", "latin.txt": "not_utf8", "big.txt": "too_large",
    });
    expect(relOut()).toEqual([]);
  });

  it("skips names with control characters or secrets, and does not print them", async () => {
    put("bad\nname.ts", "x\n");
    put(`${key}.txt`, "x\n");
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out });
    if (result.status !== "ready") throw new Error("expected ready");
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["unsafe_name", "unsafe_name"]);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("bad");
  });
});

describe("prepareWorkspace: failing closed", () => {
  it.each([
    ["missing source", () => ({ sourceDir: join(base, "nope"), outDir: out }), "source_missing"],
    ["source is a file", () => { put("f", "x"); return { sourceDir: join(raw, "f"), outDir: out }; }, "source_not_directory"],
    ["output inside source", () => ({ sourceDir: raw, outDir: join(raw, "o") }), "out_overlaps_source"],
    ["source inside output", () => ({ sourceDir: raw, outDir: base }), "out_overlaps_source"],
    ["output not empty", () => { writeFileSync(join(out, "stale"), "x"); return { sourceDir: raw, outDir: out }; }, "out_not_empty"],
  ])("refuses: %s", async (_name, options, code) => {
    const result = await prepareWorkspace(options());
    expect(result).toEqual({ status: "error", code });
  });

  it("clears partial output and reports sanitize_failed when redaction throws", async () => {
    put("a.ts", "one\n");
    put("b.ts", `x = "${key}"\n`);
    const result = await prepareWorkspace({
      sourceDir: raw,
      outDir: out,
      redact: (text) => {
        if (text.includes("gsk_")) throw new Error(`boom ${key}`);
        return redactSecretsDetailed(text);
      },
    });
    expect(result).toEqual({ status: "error", code: "sanitize_failed" });
    expect(readdirSync(out)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("fails when a second redaction pass would still change the text", async () => {
    put("a.ts", "hello\n");
    let calls = 0;
    const result = await prepareWorkspace({
      sourceDir: raw,
      outDir: out,
      redact: (text) => Object.freeze({ text: text + String(calls++), findings: Object.freeze([]) }),
    });
    expect(result).toEqual({ status: "error", code: "sanitize_failed" });
    expect(readdirSync(out)).toEqual([]);
  });

  it("fails and clears the output when a limit is exceeded", async () => {
    put("a.ts", "1\n");
    put("b.ts", "2\n");
    const result = await prepareWorkspace({ sourceDir: raw, outDir: out, maxFiles: 1 });
    expect(result).toEqual({ status: "error", code: "limit_exceeded" });
    expect(readdirSync(out)).toEqual([]);
  });
});
