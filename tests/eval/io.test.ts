import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../eval/cli.js";
import { EvalInputError, contentHash, loadAdjudications, loadLabels, loadRun, recheckCitations } from "../../eval/load.js";
import { CONSUMER_FINDING, FIXTURES, SYNTHETIC_LABELS, finding, labelsFile, leanRun, tmp } from "./helpers.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

afterEach(() => { vi.restoreAllMocks(); });

describe("loading labels, adjudications and runs", () => {
  it("hashes labels by content, not by line endings", () => {
    const text = JSON.stringify(SYNTHETIC_LABELS, null, 2);
    const lf = loadLabels(labelsFile(tmp(), text));
    const crlf = loadLabels(labelsFile(tmp(), text.replace(/\n/g, "\r\n")));
    expect(crlf.sha256).toBe(lf.sha256);
    expect(lf.sha256).toBe(contentHash(text));
    expect(loadLabels(labelsFile(tmp(), text.replace("synthetic-orders", "changed"))).sha256).not.toBe(lf.sha256);
  });

  it("rejects labels that are not in the expected shape", () => {
    expect(() => loadLabels(labelsFile(tmp(), "{}"))).toThrow(EvalInputError);
    expect(() => loadLabels(labelsFile(tmp(), "not json"))).toThrow(/not valid JSON/);
  });

  it("validates adjudications: a real note, a known verdict, and no duplicates", () => {
    const entry = { caseId: "buggy", runId: "r", findingIndex: 0, fingerprint: "0123456789abcdef", verdict: "correct", note: "read both functions" };
    const write = (list: object[]): string => { const p = join(tmp(), "adj.json"); writeFileSync(p, JSON.stringify({ adjudications: list })); return p; };
    expect(loadAdjudications(write([entry]))).toHaveLength(1);
    expect(() => loadAdjudications(write([{ ...entry, note: "ok" }]))).toThrow(EvalInputError);
    expect(() => loadAdjudications(write([{ ...entry, verdict: "great" }]))).toThrow(EvalInputError);
    expect(() => loadAdjudications(write([entry, { ...entry, verdict: "partial" }]))).toThrow(/duplicate/);
  });

  it("refuses artifacts it cannot read faithfully instead of guessing", () => {
    expect(() => loadRun(join(tmp(), "missing"))).toThrow(/not found/);
    const empty = join(tmp(), "empty");
    mkdirSync(empty);
    expect(() => loadRun(empty)).toThrow(/neither lean-findings.json nor metrics.json/);
    const legacy = join(tmp(), "legacy");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "metrics.json"), JSON.stringify({ completion: "complete", tokens: { input: 1, output: 1 }, findings: { total: 2 } }));
    expect(() => loadRun(legacy)).toThrow(/only incomplete legacy runs/);
    const lean = leanRun("badtrace");
    writeFileSync(join(lean, "lean-trace.jsonl"), "{\"event\":\"request\"}\nnot json\n");
    expect(() => loadRun(lean)).toThrow(/line 2 is not a trace event/);
  });
});

describe("independent citation re-check", () => {
  it("accepts a real file, line and quote at the head commit and rejects the rest", async () => {
    const repo = tmp();
    const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nconst order = store.load(id);\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const head = git("rev-parse", "HEAD");
    const results = await recheckCitations(repo, head, [
      finding({ file: "src/a.ts", line: 2, evidence: "const order = store.load(id);" }),
      finding({ file: "src/a.ts", line: 1, evidence: "const order = store.load(id);" }),
      finding({ file: "src/a.ts", line: 9, evidence: "const order = store.load(id);" }),
      finding({ file: "src/missing.ts", line: 1, evidence: "x" }),
      finding({ file: "src\\a.ts", line: 2, evidence: "  const   order = store.load(id);  " }),
    ]);
    expect(results).toEqual([true, false, false, false, true]);
    await expect(recheckCitations(repo, "HEAD", [])).rejects.toThrow(/40-character/);
  });
});

describe("command line", () => {
  async function run(args: string[]): Promise<string> {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
    expect(await main(args)).toBe(0);
    return out;
  }
  const args = (): string[] => ["--labels", labelsFile(tmp()), "--case", "buggy", "--run", leanRun("cli", { findings: [CONSUMER_FINDING] }), "--run", join(FIXTURES, "lean-case001-attempt2")];

  it("prints identical output for identical inputs, with the label hash and no absolute paths", async () => {
    const a = args();
    const first = await run(a);
    const second = await run(a);
    expect(second).toBe(first);
    const parsed = JSON.parse(first) as { results: { runId: string; labels: { sha256: string }; detection: string }[] };
    expect(parsed.results.map((r) => [r.runId, r.detection])).toEqual([["cli", "pending_review"], ["lean-case001-attempt2", "not_scored"]]);
    expect(parsed.results.every((r) => /^[0-9a-f]{64}$/.test(r.labels.sha256))).toBe(true);
    expect(first).not.toContain(ROOT.replace(/\\/g, "\\\\"));
  });

  it("prints a table on request and marks results that still need review", async () => {
    const out = await run([...args(), "--format", "table"]);
    expect(out).toMatch(/pending_review/);
    expect(out).toMatch(/not_scored\(incomplete\)/);
    expect(out).toMatch(/NO\s*$/m);
  });

  it("rejects bad usage with an input error", async () => {
    await expect(main([])).rejects.toThrow(EvalInputError);
    await expect(main(["--labels", "x", "--run", "y", "--bogus", "1"])).rejects.toThrow(EvalInputError);
    await expect(main(["--labels", "x", "--run", "y", "--price-in-per-m", "1"])).rejects.toThrow(/both/);
  });
});

// The scorer and the labels must never be reachable by the reviewer. These checks read the repository as the reviewer's
// Docker images see it.
describe("isolation from the reviewer", () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : files(join(dir, e.name))) : [join(dir, e.name)]);

  it("no reviewer, lean or proxy code imports the evaluator", () => {
    for (const rel of [...files("src"), ...files("experiments"), ...files("docker")].filter((f) => /\.(ts|mjs|js)$/.test(f))) {
      expect(read(rel), rel).not.toMatch(/(?:from|import)\s*\(?\s*["'][^"']*eval\//);
    }
  });

  it("no Dockerfile copies the evaluator, and the Docker build context excludes it", () => {
    for (const rel of files("docker").filter((f) => f.endsWith("Dockerfile"))) expect(read(rel), rel).not.toMatch(/\beval\b|labels|ground_truth/i);
    const ignored = read(".dockerignore").split(/\r?\n/);
    expect(ignored).toContain("eval");
    expect(ignored).toContain("dist-eval");
  });

  it("no compose file or run script mounts evaluation material", () => {
    for (const rel of [...files("docker").filter((f) => /compose.*\.yml$/.test(f)), "docker/run.sh", "experiments/lean/compose.lean.yml", "experiments/lean/e2e.sh"]) {
      expect(read(rel), rel).not.toMatch(/\beval\b|labels\.json|ground_truth|event-booking-eval/i);
    }
  });

  it("no label or ground-truth content is present where the reviewer can read it", () => {
    const markers = ["event-booking-" + "eval", "ground" + "_truth", "labels" + ".json", "hold" + "_service", "booking" + "_service"];
    for (const rel of [...files("src"), ...files("prompts"), ...files("experiments"), ...files("docker"), "docs/DEVELOPMENT_HANDOFF.md"]) {
      if (statSync(join(ROOT, rel)).size > 1_000_000) continue;
      const text = read(rel);
      for (const m of markers) expect(text, `${rel} mentions ${m}`).not.toContain(m);
    }
    for (const rel of files("eval")) for (const m of markers.slice(3)) expect(read(rel), rel).not.toContain(m);
  });
});
