import type { RemovedEntry } from "../../src/diff/filter.js";
import type { DiffEntry } from "../../src/types.js";

/** Builds a DiffEntry for tests. Line numbers default to 1..n for added and removed lines. */
export function entry(overrides: Partial<DiffEntry> & { newPath: string }): DiffEntry {
  const addedLines = overrides.addedLines ?? ["const x = 1;"];
  const removedLines = overrides.removedLines ?? [];
  return {
    oldPath: overrides.newPath,
    status: "modified",
    isBinary: false,
    isRename: false,
    patch: "",
    addedLineNumbers: addedLines.map((_, i) => i + 1),
    removedLineNumbers: removedLines.map((_, i) => i + 1),
    ...overrides,
    addedLines,
    removedLines,
  };
}

export function excluded(overrides: Partial<RemovedEntry> & { path: string }): RemovedEntry {
  return {
    oldPath: overrides.path,
    status: "modified",
    kind: "lockfile",
    reason: "lockfile",
    addedLineCount: 10,
    removedLineCount: 5,
    ...overrides,
  };
}

export const lines = (count: number, prefix = "line"): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
