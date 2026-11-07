import { DiffParseError } from "./errors.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface HunkLines {
  readonly addedLines: readonly string[];
  readonly addedLineNumbers: readonly number[];
  readonly removedLines: readonly string[];
  readonly removedLineNumbers: readonly number[];
  /** Index of the first line after this hunk. */
  readonly nextIndex: number;
}

export const stripCr = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/**
 * Parses one hunk starting at `lines[index]` (the `@@` line). The header's line counts decide where the
 * hunk ends, so content that merely looks like a file header (for example a removed line "-- x", shown
 * as "--- x") is read as content. Added lines get new-file numbers; removed lines get old-file numbers.
 */
export function parseHunk(lines: readonly string[], index: number): HunkLines {
  const header = stripCr(lines[index]!);
  if (header.startsWith("@@@")) throw new DiffParseError("unsupported combined-diff hunk (@@@)", index + 1);
  const match = HUNK_HEADER.exec(header);
  if (!match) throw new DiffParseError(`malformed hunk header "${header.slice(0, 60)}"`, index + 1);

  let oldLine = Number(match[1]);
  let newLine = Number(match[3]);
  let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
  let newLeft = match[4] === undefined ? 1 : Number(match[4]);
  const added: string[] = [];
  const addedNumbers: number[] = [];
  const removed: string[] = [];
  const removedNumbers: number[] = [];

  let i = index + 1;
  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) {
      throw new DiffParseError(`diff ended before the hunk starting at line ${index + 1} was complete`, i);
    }
    const line = stripCr(lines[i]!);
    const prefix = line.slice(0, 1);
    const lineNo = i + 1;
    if (prefix === "\\") {
      i++;
      continue;
    }
    if (prefix === " " || line === "") {
      if (oldLeft === 0 || newLeft === 0) throw tooManyLines("context", lineNo);
      oldLine++; newLine++; oldLeft--; newLeft--;
    } else if (prefix === "-") {
      if (oldLeft === 0) throw tooManyLines("removed", lineNo);
      removed.push(line.slice(1));
      removedNumbers.push(oldLine);
      oldLine++; oldLeft--;
    } else if (prefix === "+") {
      if (newLeft === 0) throw tooManyLines("added", lineNo);
      added.push(line.slice(1));
      addedNumbers.push(newLine);
      newLine++; newLeft--;
    } else {
      throw new DiffParseError(`unexpected line prefix ${JSON.stringify(prefix)} inside a hunk`, lineNo);
    }
    i++;
  }
  while (i < lines.length && lines[i]!.startsWith("\\")) i++;

  return Object.freeze({
    addedLines: Object.freeze(added),
    addedLineNumbers: Object.freeze(addedNumbers),
    removedLines: Object.freeze(removed),
    removedLineNumbers: Object.freeze(removedNumbers),
    nextIndex: i,
  });
}

function tooManyLines(kind: string, line: number): DiffParseError {
  return new DiffParseError(`hunk has more ${kind} lines than its header declares`, line);
}
