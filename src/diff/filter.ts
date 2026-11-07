import type { DiffEntry } from "../types.js";
import { stripCr } from "./hunk.js";

export interface FilterOptions {
  /** Matched against the file's base name, in any directory. */
  readonly lockfileNames: readonly string[];
  /** Matched case-insensitively against the end of the path. */
  readonly noisyExtensions: readonly string[];
  /** A file whose first lines contain one of these is treated as generated. */
  readonly generatedMarkers: readonly string[];
  /** How many leading file lines are searched for a generated marker. */
  readonly markerScanLines: number;
  /** Paths matching any of these are exempt from the generated-marker rule only. */
  readonly migrationPathPatterns: readonly RegExp[];
  readonly dropBinary: boolean;
  /** Drop renames that change no lines. */
  readonly dropRenameOnly: boolean;
}

export const DEFAULT_FILTER_OPTIONS: FilterOptions = Object.freeze({
  lockfileNames: Object.freeze([
    "bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
    "go.sum", "poetry.lock", "Pipfile.lock", "flake.lock",
  ]),
  noisyExtensions: Object.freeze([".min.js", ".min.css", ".bundle.js", ".map"]),
  // Only markers that say a file is machine-written. "eslint-disable" is deliberately not here: it
  // appears at the top of hand-written files too, so it is not evidence that a file is generated.
  generatedMarkers: Object.freeze(["@generated"]),
  markerScanLines: 10,
  migrationPathPatterns: Object.freeze([/(^|\/)(migrations?|migrate)\//i]),
  dropBinary: true,
  dropRenameOnly: true,
});

export type ExclusionKind = "binary" | "lockfile" | "bundled_asset" | "rename_only" | "generated";

/**
 * An excluded file. The content is not reviewed, but this record stays available to later stages
 * (risk routing, the report) so an excluded change is never invisible.
 */
export interface RemovedEntry {
  readonly path: string;
  readonly oldPath: string;
  readonly status: DiffEntry["status"];
  readonly kind: ExclusionKind;
  readonly reason: string;
  readonly addedLineCount: number;
  readonly removedLineCount: number;
}

interface Exclusion {
  readonly kind: ExclusionKind;
  readonly reason: string;
}

export interface FilterResult {
  readonly kept: readonly DiffEntry[];
  /** Every excluded file with the reason, so nothing is dropped silently. */
  readonly removed: readonly RemovedEntry[];
}

const FIRST_HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Splits entries into kept and removed. Deterministic: no model is involved. Every input ends up in
 * exactly one of the two lists, and each removal carries the rule that caused it.
 */
export function filterNoise(entries: readonly DiffEntry[], options: Partial<FilterOptions> = {}): FilterResult {
  const config: FilterOptions = { ...DEFAULT_FILTER_OPTIONS, ...options };
  if (!Number.isInteger(config.markerScanLines) || config.markerScanLines < 1) {
    throw new Error("markerScanLines must be a positive integer");
  }
  const kept: DiffEntry[] = [];
  const removed: RemovedEntry[] = [];
  for (const entry of entries) {
    const exclusion = classifyExclusion(entry, config);
    if (exclusion === undefined) {
      kept.push(entry);
      continue;
    }
    removed.push(
      Object.freeze({
        path: entry.newPath,
        oldPath: entry.oldPath,
        status: entry.status,
        kind: exclusion.kind,
        reason: exclusion.reason,
        addedLineCount: entry.addedLines.length,
        removedLineCount: entry.removedLines.length,
      }),
    );
  }
  return Object.freeze({ kept: Object.freeze(kept), removed: Object.freeze(removed) });
}

function classifyExclusion(entry: DiffEntry, config: FilterOptions): Exclusion | undefined {
  if (config.dropBinary && entry.isBinary) return { kind: "binary", reason: "binary file" };
  const baseName = entry.newPath.split("/").pop() ?? entry.newPath;
  if (config.lockfileNames.includes(baseName)) return { kind: "lockfile", reason: `lockfile (${baseName})` };
  const lowerPath = entry.newPath.toLowerCase();
  const extension = config.noisyExtensions.find((ext) => lowerPath.endsWith(ext.toLowerCase()));
  if (extension !== undefined) {
    return { kind: "bundled_asset", reason: `generated or bundled asset (${extension})` };
  }
  if (config.dropRenameOnly && entry.isRename && !entry.addedLines.length && !entry.removedLines.length) {
    return { kind: "rename_only", reason: "rename without content changes" };
  }
  if (config.migrationPathPatterns.some((pattern) => pattern.test(entry.newPath))) return undefined;
  const leading = leadingFileLines(entry, config.markerScanLines);
  const marker = config.generatedMarkers.find((m) => leading.some((line) => line.includes(m)));
  return marker === undefined
    ? undefined
    : {
        kind: "generated",
        reason: `generated file (marker "${marker}" in the first ${config.markerScanLines} lines)`,
      };
}

/**
 * The first lines of the new file, as far as the diff shows them: all added lines for a new file, or the
 * context and added lines of a first hunk that starts at line 1. A modified file whose top of file is
 * not in the diff cannot be judged, so it is kept.
 */
function leadingFileLines(entry: DiffEntry, count: number): readonly string[] {
  if (entry.status === "added") return entry.addedLines.slice(0, count);
  if (entry.status === "deleted") return [];
  const patchLines = entry.patch.split("\n").map(stripCr);
  const hunkIndex = patchLines.findIndex((line) => FIRST_HUNK.test(line));
  if (hunkIndex === -1 || Number(FIRST_HUNK.exec(patchLines[hunkIndex]!)![1]) > 1) return [];
  const leading: string[] = [];
  for (const line of patchLines.slice(hunkIndex + 1)) {
    if (line.startsWith("@@") || leading.length >= count) break;
    if (line.startsWith(" ") || line.startsWith("+")) leading.push(line.slice(1));
  }
  return leading;
}
