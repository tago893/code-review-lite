import { EvalInputError, loadAdjudications, loadLabels, loadRun, recheckCitations } from "./load.js";
import { scoreRun, type Prices, type ScoreResult } from "./score.js";

// Offline command line around the scorer. It reads artifacts and labels, prints a result, and exits. No network, no
// model, no writes.
//
//   node dist-eval/cli.js --labels <labels.json> --run <artifact> [--run <artifact> ...] [--case <id>]
//        [--adjudications <file>] [--bench-repo <git dir>] [--price-in-per-m <usd> --price-out-per-m <usd>] [--format json|table]

const USAGE = "usage: cli.js --labels <labels.json> --run <artifact>... [--case <id>] [--adjudications <file>] [--bench-repo <dir>] [--price-in-per-m <usd> --price-out-per-m <usd>] [--format json|table]";

interface Args {
  readonly labels: string;
  readonly runs: readonly string[];
  readonly caseId: string | null;
  readonly adjudications: string | null;
  readonly benchRepo: string | null;
  readonly prices: Prices | null;
  readonly format: "json" | "table";
}

function parseArgs(argv: readonly string[]): Args {
  const single = new Map<string, string>();
  const runs: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? "";
    const value = argv[i + 1];
    if (!key.startsWith("--") || value === undefined) throw new EvalInputError(USAGE);
    if (key === "--run") runs.push(value); else single.set(key, value);
  }
  const known = new Set(["--labels", "--case", "--adjudications", "--bench-repo", "--price-in-per-m", "--price-out-per-m", "--format"]);
  for (const key of single.keys()) if (!known.has(key)) throw new EvalInputError(USAGE);
  const labels = single.get("--labels");
  if (!labels || runs.length === 0) throw new EvalInputError(USAGE);
  const priceIn = single.get("--price-in-per-m");
  const priceOut = single.get("--price-out-per-m");
  if ((priceIn === undefined) !== (priceOut === undefined)) throw new EvalInputError("give both --price-in-per-m and --price-out-per-m, or neither");
  const num = (v: string): number => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new EvalInputError("prices must be non-negative numbers"); return n; };
  const format = single.get("--format") ?? "json";
  if (format !== "json" && format !== "table") throw new EvalInputError(USAGE);
  return {
    labels, runs, format,
    caseId: single.get("--case") ?? null,
    adjudications: single.get("--adjudications") ?? null,
    benchRepo: single.get("--bench-repo") ?? null,
    prices: priceIn !== undefined && priceOut !== undefined ? { inPerMillion: num(priceIn), outPerMillion: num(priceOut) } : null,
  };
}

function table(results: readonly ScoreResult[]): string {
  const rows = results.map((r) => [r.runId, r.completion.status + (r.completion.reason ? `:${r.completion.reason}` : ""), r.detection + (r.detectionNote ? `(${r.detectionNote})` : ""), r.cleanControl, `${r.falsePositives.count}+${r.falsePositives.pendingReview}?`, r.citation.validity === null ? "-" : String(r.citation.validity), `${r.metrics.tokensIn ?? "-"}/${r.metrics.tokensOut ?? "-"}`, r.final ? "yes" : "NO"]);
  const head = ["run", "completion", "detection", "clean", "FP(+pending)", "citation", "tokens in/out", "final"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const labels = loadLabels(args.labels);
  const adjudications = args.adjudications ? loadAdjudications(args.adjudications) : [];
  const results: ScoreResult[] = [];
  for (const path of args.runs) {
    const run = loadRun(path);
    const head = args.caseId === null ? run.headSha : (labels.labels.cases[args.caseId]?.headCommit ?? null);
    const recheck = args.benchRepo && head ? await recheckCitations(args.benchRepo, head, run.findings) : null;
    results.push(scoreRun({ labels, caseId: args.caseId, run, adjudications, recheck, prices: args.prices }));
  }
  process.stdout.write(args.format === "table" ? `${table(results)}\n` : `${JSON.stringify({ results }, null, 2)}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof EvalInputError ? error.message : "internal error"}\n`);
    process.exitCode = error instanceof EvalInputError ? 65 : 70;
  });
}
