import type { RemovedEntry } from "../diff/filter.js";
import type { Category, DiffEntry, Tier } from "../types.js";
import { detectSignals, type RiskSignal } from "./signals.js";

const TRIVIAL_MAX_LINES = 10;
const LITE_MAX_LINES = 100;
const MAX_FILES_BELOW_FULL = 20;

const TIER_ORDER: readonly Tier[] = ["trivial", "lite", "full"];

const AGENTS_BY_TIER: Readonly<Record<Tier, readonly Category[]>> = Object.freeze({
  trivial: Object.freeze<Category[]>(["code_quality"]),
  lite: Object.freeze<Category[]>(["code_quality", "security"]),
  full: Object.freeze<Category[]>(["code_quality", "security", "performance"]),
});

export interface RiskAssessment {
  /** The tier to run: the higher of the size floor and the behavior-signal tier. */
  readonly tier: Tier;
  /** What size alone would give. Size sets review effort; it is not evidence of risk. */
  readonly floorTier: Tier;
  /** "full" if any behavior signal fired, otherwise "trivial". */
  readonly signalTier: Tier;
  readonly reasons: readonly string[];
  readonly agents: readonly Category[];
  readonly signals: readonly RiskSignal[];
  /** Changes whose behavior impact could not be determined. Reported; they do not raise the tier. */
  readonly uncertainties: readonly string[];
  readonly size: { readonly changedLines: number; readonly files: number };
}

const maxTier = (a: Tier, b: Tier): Tier => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

/**
 * Chooses how many reviewers to run. Size sets a floor; behavior signals can only raise the tier. A large
 * plain diff is full because of its size and says so, and a one-line change with a dangerous signal is full
 * because of the signal. `excluded` is the noise filter's metadata, so exclusions still count.
 */
export function assessRiskTier(
  entries: readonly DiffEntry[],
  excluded: readonly RemovedEntry[] = [],
): RiskAssessment {
  const size = measure(entries);
  const floorTier = sizeFloor(size.changedLines, size.files);
  const signals = detectSignals(entries, excluded);
  const signalTier: Tier = signals.length > 0 ? "full" : "trivial";
  const tier = maxTier(floorTier, signalTier);

  return Object.freeze({
    tier,
    floorTier,
    signalTier,
    reasons: Object.freeze([sizeReason(size, floorTier), ...signals.map(signalReason)]),
    agents: AGENTS_BY_TIER[tier],
    signals,
    uncertainties: Object.freeze(findUncertainties(entries, excluded)),
    size,
  });
}

function measure(entries: readonly DiffEntry[]): { changedLines: number; files: number } {
  const changedLines = entries.reduce((sum, e) => sum + e.addedLines.length + e.removedLines.length, 0);
  return Object.freeze({ changedLines, files: entries.length });
}

function sizeFloor(changedLines: number, files: number): Tier {
  if (files > MAX_FILES_BELOW_FULL || changedLines > LITE_MAX_LINES) return "full";
  return changedLines <= TRIVIAL_MAX_LINES ? "trivial" : "lite";
}

function sizeReason(size: { changedLines: number; files: number }, floor: Tier): string {
  const lines = `${size.changedLines} changed line${size.changedLines === 1 ? "" : "s"}`;
  const files = `${size.files} file${size.files === 1 ? "" : "s"}`;
  if (size.changedLines === 0 && size.files === 0) return "size: no reviewable changes (trivial floor)";
  return `size: ${lines} in ${files} (${floor} floor)`;
}

function signalReason(signal: RiskSignal): string {
  const where = signal.line === undefined ? signal.file : `${signal.file}:${signal.line}`;
  return `${signal.signal} [${signal.family}] at ${where}: ${signal.reason}`;
}

function findUncertainties(entries: readonly DiffEntry[], excluded: readonly RemovedEntry[]): string[] {
  const notes: string[] = [];
  for (const item of excluded) {
    if (item.kind === "binary" || item.kind === "generated" || item.kind === "bundled_asset") {
      notes.push(`${item.path}: ${item.reason}; content was not analysed, so its behavior impact is unknown`);
    }
  }
  for (const entry of entries) {
    const hasLines = entry.addedLines.length > 0 || entry.removedLines.length > 0;
    if (entry.isBinary || (!hasLines && !entry.isRename)) {
      notes.push(
        `${entry.newPath}: no line content is available (binary file, mode change or empty file); behavior impact cannot be determined`,
      );
    }
  }
  return notes;
}
