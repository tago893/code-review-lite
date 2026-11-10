import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLabels, type LoadedLabels } from "../../eval/load.js";

// Synthetic labels in the real label file's shape. The paths, symbols and wording are invented, so no real benchmark
// ground truth lives in this repository. The commits are the real Event Booking ones only so that the real historical
// artifacts in tests/fixtures/eval pass the provenance check.

export const BASE = "b70fc05a693a01012b4c5eaab669c385e8baf0d7";
export const HEAD_BUGGY = "63f9aa53c1ad2944e6cb0e1cf19d901748ace30b";
export const HEAD_CLEAN = "6e1d9a65d28649198ed295f255fe54e6933b8876";
export const FIXTURES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/eval");

export const SYNTHETIC_LABELS = {
  schemaVersion: 1,
  benchmark: "synthetic-orders",
  baseCommit: BASE,
  scoringPolicy: { evaluateOnlyIntroducedRegressions: true, suggestionsAreReportedSeparatelyFromWarningCriticalFalsePositives: true },
  cases: {
    buggy: {
      headCommit: HEAD_BUGGY,
      expectedRegression: true,
      acceptedLocations: [
        { file: "src/orders/store.ts", symbol: "OrderStore.load", lineRange: { start: 10, end: 20 }, locationRole: "changed_source" },
        { file: "src/orders/checkout.ts", symbol: "Checkout.pay", lineRange: { start: 5, end: 30 }, locationRole: "unchanged_consumer" },
      ],
      rootCause: {
        description: "load returns stale entries; pay trusts it",
        requiredConceptRegexes: ["(?:stale|outdated)", "cache", "(?:checkout|payment|caller)"],
        regexFlags: "i",
        uncreditedClaims: ["double[- ]?charg"],
      },
    },
    clean: { headCommit: HEAD_CLEAN, expectedRegression: false, acceptedLocations: [], rootCause: null, warningOrCriticalRegressionsAllowed: 0 },
    clean_same_head: { headCommit: HEAD_BUGGY, expectedRegression: false, acceptedLocations: [], rootCause: null, warningOrCriticalRegressionsAllowed: 0 },
  },
} as const;

export function tmp(): string { return mkdtempSync(join(tmpdir(), "eval-")); }

export function labelsFile(dir: string, text: string = JSON.stringify(SYNTHETIC_LABELS, null, 2)): string {
  const path = join(dir, "labels.json");
  writeFileSync(path, text);
  return path;
}

export function syntheticLabels(): LoadedLabels { return loadLabels(labelsFile(tmp())); }

export interface FindingInput { file?: string; line?: number; severity?: "critical" | "warning" | "suggestion"; claim?: string; path?: string; evidence?: string }

export function finding(over: FindingInput = {}) {
  return { severity: "warning" as const, category: "code_quality", file: "src/other.ts", line: 3, evidence: "const x = 1;", claim: "An unrelated remark.", path: "a -> b", ...over };
}

/** Writes a lean-findings.json (and no trace) the way experiments/lean/run.ts does, and returns the folder. */
export function leanRun(name: string, over: { status?: "complete" | "incomplete"; reason?: string; findings?: object[]; dropped?: string[]; head?: string; tokensIn?: number; tokensOut?: number } = {}): string {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lean-findings.json"), JSON.stringify({
    status: over.status ?? "complete", ...(over.reason ? { reason: over.reason } : {}),
    findings: over.findings ?? [], dropped: over.dropped ?? [], turns: 3, tokensIn: over.tokensIn ?? 1000, tokensOut: over.tokensOut ?? 100,
    baseSha: BASE, headSha: over.head ?? HEAD_BUGGY,
  }));
  return dir;
}

export const CONSUMER_FINDING = finding({
  file: "src/orders/checkout.ts", line: 12, severity: "warning",
  claim: "Checkout.pay trusts OrderStore.load, which can return a stale cached entry, so payment proceeds on outdated data.",
  path: "pay -> load (cache fallback)", evidence: "const order = store.load(id);",
});
