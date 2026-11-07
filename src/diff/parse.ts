import type { DiffEntry, DiffStatus } from "../types.js";
import { DiffParseError } from "./errors.js";
import { parseHunk, stripCr } from "./hunk.js";
import { parseBareOrQuoted, parseDiffGitHeader, parseFileNameLine, type HeaderPaths } from "./paths.js";

export { DiffParseError } from "./errors.js";

const GIT_HEADER = "diff --git ";
const IGNORED_HEADERS = /^(old mode|new mode|index|similarity index|dissimilarity index) /;
const BINARY_FILES = /^Binary files (.+) and (.+) differ$/;

/** Mutable only while one file section is being read; frozen into a DiffEntry afterwards. */
interface SectionState {
  status: DiffStatus | undefined;
  isBinary: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  /** undefined: no `---` line seen; null: /dev/null. */
  minusPath: string | null | undefined;
  plusPath: string | null | undefined;
  hunkSeen: boolean;
  added: string[];
  addedNumbers: number[];
  removed: string[];
  removedNumbers: number[];
}

/**
 * Parses `git diff` output into one entry per file. Pure and deterministic. Throws DiffParseError for
 * malformed input and for features it does not support (combined diffs, copies, diffs made without the
 * default a/ b/ prefixes) rather than guessing. CR is stripped from line content.
 */
export function parseUnifiedDiff(text: string): readonly DiffEntry[] {
  if (text.trim() === "") return Object.freeze([]);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const starts = sectionStarts(lines);
  if (starts[0] !== 0) {
    throw new DiffParseError('expected the diff to begin with a "diff --git" header', 1);
  }
  const entries = starts.map((start, n) => parseSection(lines, start, starts[n + 1] ?? lines.length));
  return Object.freeze(entries);
}

function sectionStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  lines.forEach((raw, index) => {
    const line = stripCr(raw);
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      throw new DiffParseError("unsupported combined diff", index + 1);
    }
    if (line.startsWith(GIT_HEADER)) starts.push(index);
  });
  return starts;
}

function parseSection(lines: readonly string[], start: number, end: number): DiffEntry {
  const headerPaths = parseDiffGitHeader(stripCr(lines[start]!).slice(GIT_HEADER.length), start + 1);
  const state: SectionState = {
    status: undefined, isBinary: false, renameFrom: undefined, renameTo: undefined,
    minusPath: undefined, plusPath: undefined, hunkSeen: false,
    added: [], addedNumbers: [], removed: [], removedNumbers: [],
  };

  let i = start + 1;
  while (i < end) {
    const line = stripCr(lines[i]!);
    if (line.startsWith("@@")) {
      const hunk = parseHunk(lines, i);
      state.hunkSeen = true;
      state.added.push(...hunk.addedLines);
      state.addedNumbers.push(...hunk.addedLineNumbers);
      state.removed.push(...hunk.removedLines);
      state.removedNumbers.push(...hunk.removedLineNumbers);
      i = hunk.nextIndex;
      continue;
    }
    if (line === "GIT binary patch") {
      state.isBinary = true;
      break; // the rest of the section is encoded binary data
    }
    readHeaderLine(line, i + 1, state);
    i++;
  }

  const patch = lines.slice(start, end).join("\n") + "\n";
  return buildEntry(state, headerPaths, patch, start + 1);
}

function readHeaderLine(line: string, lineNo: number, state: SectionState): void {
  if (IGNORED_HEADERS.test(line)) return;
  if (line.startsWith("new file mode ")) state.status = "added";
  else if (line.startsWith("deleted file mode ")) state.status = "deleted";
  else if (line.startsWith("rename from ")) state.renameFrom = parseBareOrQuoted(line.slice(12), lineNo);
  else if (line.startsWith("rename to ")) state.renameTo = parseBareOrQuoted(line.slice(10), lineNo);
  else if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
    throw new DiffParseError("unsupported file copy (run git diff without -C)", lineNo);
  } else if (!state.hunkSeen && line.startsWith("--- ")) state.minusPath = parseFileNameLine(line.slice(4), "a/", lineNo);
  else if (!state.hunkSeen && line.startsWith("+++ ")) state.plusPath = parseFileNameLine(line.slice(4), "b/", lineNo);
  else if (BINARY_FILES.test(line)) readBinaryLine(line, state);
  else throw new DiffParseError(`unrecognised header line ${JSON.stringify(line.slice(0, 60))}`, lineNo);
}

function readBinaryLine(line: string, state: SectionState): void {
  state.isBinary = true;
  const match = BINARY_FILES.exec(line)!;
  if (match[1] === "/dev/null") state.status = "added";
  else if (match[2] === "/dev/null") state.status = "deleted";
}

function buildEntry(state: SectionState, header: HeaderPaths | null, patch: string, line: number): DiffEntry {
  const isRename = state.renameFrom !== undefined || state.renameTo !== undefined;
  if (isRename && (state.renameFrom === undefined || state.renameTo === undefined)) {
    throw new DiffParseError("incomplete rename (needs both rename from and rename to)", line);
  }
  const status: DiffStatus = isRename
    ? "renamed"
    : state.status ?? (state.minusPath === null ? "added" : state.plusPath === null ? "deleted" : "modified");

  const oldName = state.renameFrom ?? state.minusPath ?? header?.oldPath;
  const newName = state.renameTo ?? state.plusPath ?? header?.newPath;
  // An added file has no old path and a deleted file has no new path: both sides use the one that exists.
  const oldPath = status === "added" ? newName : oldName;
  const newPath = status === "deleted" ? oldName : newName;
  if (!oldPath || !newPath) {
    throw new DiffParseError("cannot determine the file path from this diff header", line);
  }

  return Object.freeze({
    oldPath,
    newPath,
    status,
    addedLines: Object.freeze([...state.added]),
    removedLines: Object.freeze([...state.removed]),
    addedLineNumbers: Object.freeze([...state.addedNumbers]),
    removedLineNumbers: Object.freeze([...state.removedNumbers]),
    isBinary: state.isBinary,
    isRename,
    patch,
  });
}
