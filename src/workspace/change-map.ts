import { readSnapshotLines } from "../verify/citation.js";
import { declaredSymbols } from "../verify/relation.js";
import { isTestPath } from "../risk/paths.js";
import type { DiffEntry } from "../types.js";
import { enclosingFunction, isSupportedSource, type FunctionSpan } from "./enclosing.js";

export const MAX_CHANGED_FUNCTIONS = 12;
export const MAX_CALLERS_PER_FUNCTION = 5;
export const MAX_SLICE_LINES = 40;
export const SLICE_WINDOW = 5;
/** Budget for the rendered map; used by the prompt renderer, not by the builder. */
export const MAX_CHANGE_MAP_CHARS = 6_000;
const MIN_NAME_LENGTH = 3;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DUNDER = /^__\w+__$/;

export interface CodeSlice { readonly startLine: number; readonly endLine: number; readonly text: string }
export interface CallSite { readonly path: string; readonly line: number; readonly caller?: FunctionSpan; readonly slice: CodeSlice }
export interface ChangedFunction {
  readonly path: string;
  readonly span: FunctionSpan;
  readonly changedLines: readonly number[];
  readonly callersSearched: boolean;
  readonly callers: readonly CallSite[];
  readonly moreCallers: number;
}
export interface ChangeMap { readonly functions: readonly ChangedFunction[]; readonly omittedFunctions: number; readonly unreadableFiles: number }

type LineReader = (path: string) => Promise<readonly string[] | undefined>;

/** Reads each snapshot file at most once per call; an unreadable file yields undefined. */
function cachedReader(root: string): { read: LineReader; failed: ReadonlySet<string> } {
  const cache = new Map<string, Promise<readonly string[] | undefined>>();
  const failed = new Set<string>();
  const read: LineReader = (path) => {
    let hit = cache.get(path);
    if (!hit) {
      hit = readSnapshotLines(root, path).catch(() => { failed.add(path); return undefined; });
      cache.set(path, hit);
    }
    return hit;
  };
  return { read, failed };
}

/** The new-file line just before each removed run in the patch. */
function removalPositions(patch: string): number[] {
  const positions: number[] = [];
  let newLine = 0;
  let inRun = false;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) { newLine = Number(header[1]); inRun = false; continue; }
    if (line.startsWith("-") && newLine > 0) {
      if (!inRun) positions.push(newLine - 1);
      inRun = true;
    } else {
      inRun = false;
      if (line.startsWith("+") || line.startsWith(" ")) newLine++;
    }
  }
  return positions;
}

interface Candidate { readonly path: string; readonly span: FunctionSpan; readonly added: Set<number>; readonly removals: Set<number> }

async function changedSpans(entries: readonly DiffEntry[], read: LineReader): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  for (const entry of entries) {
    const path = entry.newPath;
    if (entry.status === "deleted" || entry.isBinary || isTestPath(path) || !isSupportedSource(path)) continue;
    const lines = await read(path);
    if (!lines) continue;
    const place = (lineNo: number, kind: "added" | "removals"): void => {
      const span = lineNo >= 1 ? enclosingFunction(path, lines, lineNo) : undefined;
      if (!span) return;
      const key = `${path}:${span.startLine}`;
      const candidate = found.get(key) ?? { path, span, added: new Set<number>(), removals: new Set<number>() };
      candidate[kind].add(lineNo);
      found.set(key, candidate);
    };
    for (const n of entry.addedLineNumbers) place(n, "added");
    for (const n of removalPositions(entry.patch)) place(n, "removals");
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path) || a.span.startLine - b.span.startLine);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isSearchable = (name: string): boolean => name.length >= MIN_NAME_LENGTH && !DUNDER.test(name);

function declares(path: string, line: string, name: string): boolean {
  if (path.toLowerCase().endsWith(".py")) return new RegExp(`^\\s*(?:(?:async\\s+)?def|class)\\s+${escapeRegExp(name)}\\b`).test(line);
  return declaredSymbols(line).includes(name);
}

function sliceOf(lines: readonly string[], line: number, caller: FunctionSpan | undefined): CodeSlice {
  const lo = caller?.startLine ?? 1;
  const hi = caller?.endLine ?? lines.length;
  const whole = hi - lo + 1 <= MAX_SLICE_LINES && caller !== undefined;
  const startLine = whole ? lo : Math.max(lo, line - SLICE_WINDOW);
  const endLine = whole ? hi : Math.min(hi, line + SLICE_WINDOW);
  return Object.freeze({ startLine, endLine, text: lines.slice(startLine - 1, endLine).join("\n") });
}

interface Target { readonly candidate: Candidate; readonly pattern: RegExp; readonly sites: CallSite[] }

async function collectCallers(targets: readonly Target[], files: readonly string[], read: LineReader): Promise<void> {
  for (const path of files.filter(isSupportedSource)) {
    const lines = await read(path);
    if (!lines) continue;
    lines.forEach((text, index) => {
      const line = index + 1;
      for (const { candidate, pattern, sites } of targets) {
        if (!pattern.test(text) || declares(path, text, candidate.span.name)) continue;
        if (path === candidate.path && line >= candidate.span.startLine && line <= candidate.span.endLine) continue;
        const caller = enclosingFunction(path, lines, line);
        sites.push(Object.freeze({ path, line, ...(caller ? { caller } : {}), slice: sliceOf(lines, line, caller) }));
      }
    });
  }
}

const byCallerOrder = (a: CallSite, b: CallSite): number =>
  Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line;

function toChangedFunction(target: Target, searched: boolean): ChangedFunction {
  const { candidate, sites } = target;
  const ordered = [...sites].sort(byCallerOrder);
  const changed = candidate.added.size > 0 ? candidate.added : candidate.removals;
  return Object.freeze({
    path: candidate.path,
    span: candidate.span,
    changedLines: Object.freeze([...changed].sort((a, b) => a - b)),
    callersSearched: searched,
    callers: Object.freeze(ordered.slice(0, MAX_CALLERS_PER_FUNCTION)),
    moreCallers: Math.max(0, ordered.length - MAX_CALLERS_PER_FUNCTION),
  });
}

/** The function each changed line sits in, plus the places that call it. Reads only from the snapshot. */
export async function buildChangeMap(snapshotRoot: string, entries: readonly DiffEntry[], files: readonly string[]): Promise<ChangeMap> {
  const { read, failed } = cachedReader(snapshotRoot);
  const all = await changedSpans(entries, read);
  const kept = all.slice(0, MAX_CHANGED_FUNCTIONS);
  const targets: Target[] = kept.map((candidate) => ({
    candidate,
    pattern: new RegExp(`(?<![\\w$])${escapeRegExp(candidate.span.name)}\\s*\\(`),
    sites: [],
  }));
  await collectCallers(targets.filter((t) => isSearchable(t.candidate.span.name)), files, read);
  const unreadable = files.filter((f) => isSupportedSource(f) && failed.has(f)).length;
  return Object.freeze({
    functions: Object.freeze(targets.map((t) => toChangedFunction(t, isSearchable(t.candidate.span.name)))),
    omittedFunctions: all.length - kept.length,
    unreadableFiles: unreadable,
  });
}

const MAP_HEADING = "Changed functions and who calls them (found by text search before the review; a caller may be missing or unrelated):";
const SLICES_OMITTED = "[caller slices omitted for length; read them with cra_read]";
const SLICE_NUMBER_WIDTH = 5;

/** Consecutive line numbers as ranges: [91,92,93,97] -> "91-93, 97". */
function lineRanges(lines: readonly number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    ranges.push(j === i ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return ranges.join(", ");
}

function indexLines(fn: ChangedFunction): string[] {
  const out = [`- ${fn.path}:${fn.span.startLine}-${fn.span.endLine} ${fn.span.name} (changed lines ${lineRanges(fn.changedLines)})`];
  for (const site of fn.callers) {
    const where = site.caller ? ` in ${site.caller.name} (lines ${site.caller.startLine}-${site.caller.endLine})` : "";
    out.push(`  - called at ${site.path}:${site.line}${where}`);
  }
  if (fn.moreCallers > 0) out.push(`  [${fn.moreCallers} more callers not listed]`);
  if (!fn.callersSearched) out.push("  [callers not searched: name too short or special]");
  return out;
}

function sliceBlock(site: CallSite): string {
  const { slice } = site;
  const name = site.caller ? ` (${site.caller.name})` : "";
  const numbered = slice.text.split("\n").map((line, i) => `${String(slice.startLine + i).padStart(SLICE_NUMBER_WIDTH)}  ${line}`);
  return `--- ${site.path}:${slice.startLine}-${slice.endLine}${name} ---\n${numbered.join("\n")}\n`;
}

/** The map as prompt text: an index of changed functions and callers, then caller code while it fits in `maxChars`. */
export function renderChangeMap(map: ChangeMap, maxChars: number = MAX_CHANGE_MAP_CHARS): string {
  if (map.functions.length === 0) return "";
  const index = map.functions.flatMap(indexLines);
  if (map.omittedFunctions > 0) index.push(`[${map.omittedFunctions} more changed functions not listed]`);
  let text = `${MAP_HEADING}\n${index.join("\n")}\n`;
  const seen = new Set<string>();
  let slices = "";
  let omitted = false;
  for (const site of map.functions.flatMap((f) => f.callers)) {
    const key = `${site.path}:${site.slice.startLine}-${site.slice.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = sliceBlock(site);
    const heading = slices === "" ? "\nCaller code:\n" : "";
    if (text.length + heading.length + slices.length + block.length > maxChars) { omitted = true; continue; }
    slices += `${heading}${block}`;
  }
  text += slices;
  return omitted ? `${text}${SLICES_OMITTED}\n` : text;
}
