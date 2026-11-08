import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LIMITS } from "./limits.js";
import { ToolError, isDirectory, isRegularFile, resolveWithin, type Roots } from "./paths.js";

// Bounded read-only exploration of the sanitised snapshot. Nothing here runs repository code: files are read as text,
// searches run through ripgrep (linear-time regexes, no filters or preprocessors), and every result is cut at a hard
// limit with an explicit marker that says how to continue.

const BYTES = (text: string): number => Buffer.byteLength(text, "utf8");

// --- read -------------------------------------------------------------------------------------------------------

export const readArgs = z.object({
  path: z.string().min(1).max(LIMITS.maxPathChars),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});

/** Lines `offset`..`offset+limit-1` of a text file, each prefixed with its original line number. */
export function readTool(roots: Roots, raw: unknown): string {
  const args = readArgs.parse(raw);
  const target = resolveWithin(roots, args.path);
  if (!isRegularFile(target.abs)) throw new ToolError("not_a_file", "not a regular file; use list for directories");
  const size = lstatSync(target.abs).size;
  if (size > LIMITS.maxFileBytes) throw new ToolError("too_large", `file is ${size} bytes; use grep to find the part you need, then read with an offset`);
  if (looksBinary(target.abs)) throw new ToolError("binary", "binary file; not shown");

  const lines = splitLines(readFileSync(target.abs, "utf8"));
  const offset = args.offset ?? 1;
  if (offset > Math.max(lines.length, 1)) throw new ToolError("offset_past_end", `file has ${lines.length} lines`);
  const limit = Math.min(args.limit ?? LIMITS.defaultReadLines, LIMITS.maxReadLines);

  const out: string[] = [];
  let bytes = 0;
  let next = offset;
  for (; next < offset + limit && next <= lines.length; next++) {
    const line = `${next}: ${clip(lines[next - 1] ?? "")}`;
    if (bytes + BYTES(line) + 1 > LIMITS.maxReadBytes && out.length > 0) break;
    out.push(line);
    bytes += BYTES(line) + 1;
  }
  const shownTo = next - 1;
  const header = `${target.shown} (lines ${offset}-${shownTo} of ${lines.length})`;
  const footer =
    next <= lines.length
      ? `[TRUNCATED: ${lines.length - shownTo} more lines not shown. Call read again with path="${target.shown}" offset=${next}]`
      : "[END OF FILE]";
  return [header, ...out, footer].join("\n");
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function clip(line: string): string {
  return line.length <= LIMITS.maxLineChars ? line : `${line.slice(0, LIMITS.maxLineChars)}…[line truncated, ${line.length} chars]`;
}

function looksBinary(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

// --- list -------------------------------------------------------------------------------------------------------

export const listArgs = z.object({ path: z.string().max(LIMITS.maxPathChars).optional() });

/** One directory level: directories first (with a trailing slash), then files. Symlinks are not listed. */
export function listTool(roots: Roots, raw: unknown): string {
  const args = listArgs.parse(raw);
  const target = resolveWithin(roots, args.path);
  if (!isDirectory(target.abs)) throw new ToolError("not_a_directory", "not a directory");
  const entries = readdirSync(target.abs, { withFileTypes: true })
    .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
  return capLines(`${target.shown}/`, entries, LIMITS.maxListEntries, LIMITS.maxListBytes, "more entries; list a subdirectory or use glob");
}

// --- glob -------------------------------------------------------------------------------------------------------

export const globArgs = z.object({ pattern: z.string().min(1).max(LIMITS.maxPatternChars), path: z.string().max(LIMITS.maxPathChars).optional() });

/** File paths matching a glob such as `src/**\/*.ts`, relative to the snapshot. */
export async function globTool(roots: Roots, raw: unknown): Promise<string> {
  const args = globArgs.parse(raw);
  const target = resolveWithin(roots, args.path);
  if (!isDirectory(target.abs)) throw new ToolError("not_a_directory", "path must be a directory");
  const run = await ripgrep(["--files", "--glob", args.pattern, "--", "."], target.abs, LIMITS.maxGlobResults + 1, LIMITS.maxListBytes);
  const files = run.lines.map(stripDot).sort();
  const shown = files.slice(0, LIMITS.maxGlobResults).map((f) => joinShown(target.shown, f));
  return capLines(`${shown.length} file(s) matching ${JSON.stringify(args.pattern)} under ${target.shown}`, shown, LIMITS.maxGlobResults, LIMITS.maxListBytes, "more files; use a narrower pattern or path", run.cut || files.length > LIMITS.maxGlobResults);
}

// --- grep -------------------------------------------------------------------------------------------------------

export const grepArgs = z.object({
  pattern: z.string().min(1).max(LIMITS.maxPatternChars),
  path: z.string().max(LIMITS.maxPathChars).optional(),
  include: z.string().max(LIMITS.maxPatternChars).optional(),
  literal: z.boolean().optional(),
});

/** Matching lines as `path:line: text`, at most a fixed number, with a marker when there are more. */
export async function grepTool(roots: Roots, raw: unknown): Promise<string> {
  const args = grepArgs.parse(raw);
  const target = resolveWithin(roots, args.path);
  const cwd = isDirectory(target.abs) ? target.abs : join(target.abs, "..");
  const scope = isDirectory(target.abs) ? "." : target.abs.slice(cwd.length + 1);
  const flags = [
    "--line-number", "--no-heading", "--with-filename", "--color", "never",
    "--max-columns", String(LIMITS.maxLineChars), "--max-columns-preview",
    "--max-filesize", `${LIMITS.maxGrepFileBytes}`, "--max-count", String(LIMITS.maxGrepMatchesPerFile),
    ...(args.literal === true ? ["--fixed-strings"] : []),
    ...(args.include !== undefined ? ["--glob", args.include] : []),
  ];
  const run = await ripgrep([...flags, "-e", args.pattern, "--", scope], cwd, LIMITS.maxGrepMatches + 1, LIMITS.maxGrepBytes);
  const hits = run.lines
    .map(stripDot)
    .filter((l) => /^[^:]+:\d+:/.test(l))
    .slice(0, LIMITS.maxGrepMatches)
    .map((l) => l.replace(/^([^:]+):(\d+):\s?/, (_m, file: string, n: string) => `${joinShown(isDirectory(target.abs) ? target.shown : parentShown(target.shown), file)}:${n}: `));
  const more = run.cut || run.lines.length > LIMITS.maxGrepMatches;
  const title = `${hits.length}${more ? "+" : ""} match(es) for ${JSON.stringify(args.pattern)}`;
  return capLines(title, hits, LIMITS.maxGrepMatches, LIMITS.maxGrepBytes, "more matches or the search was cut short; narrow the pattern, path or include glob", more, run.timedOut);
}

// --- shared -----------------------------------------------------------------------------------------------------

const stripDot = (line: string): string => (line.startsWith("./") ? line.slice(2) : line);
const joinShown = (base: string, rel: string): string => (base === "." ? rel : base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`);
const parentShown = (shown: string): string => (shown.includes("/") ? shown.slice(0, shown.lastIndexOf("/")) : ".");

function capLines(title: string, lines: readonly string[], maxLines: number, maxBytes: number, moreHint: string, forceMore = false, timedOut = false): string {
  const out: string[] = [];
  let bytes = BYTES(title);
  let cutBytes = false;
  for (const line of lines.slice(0, maxLines)) {
    if (bytes + BYTES(line) + 1 > maxBytes) { cutBytes = true; break; }
    out.push(line);
    bytes += BYTES(line) + 1;
  }
  const truncated = forceMore || cutBytes || lines.length > maxLines || timedOut;
  return [title, ...out, ...(truncated ? [`[TRUNCATED${timedOut ? " (search timed out)" : ""}: ${moreHint}]`] : [])].join("\n");
}

interface RipgrepRun {
  readonly lines: readonly string[];
  /** Output was stopped early because a limit was reached. */
  readonly cut: boolean;
  readonly timedOut: boolean;
}

/**
 * Runs ripgrep with a fixed, safe argument vector (no shell, no config file, hidden files included, ignore files
 * not consulted, symlinks not followed) and stops it once enough output has been read or the time is up.
 */
function ripgrep(args: readonly string[], cwd: string, maxLines: number, maxBytes: number): Promise<RipgrepRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("rg", ["--no-config", "--no-ignore", "--hidden", "--glob", "!node_modules", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    let bytes = 0;
    let cut = false;
    let timedOut = false;
    const lines: string[] = [];
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, LIMITS.grepTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += BYTES(chunk);
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (lines.length < maxLines) lines.push(part);
      if (lines.length >= maxLines || bytes > maxBytes * 4) { cut = true; child.kill("SIGKILL"); }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(new ToolError("search_unavailable", `search failed to start: ${(error as NodeJS.ErrnoException).code ?? "error"}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer !== "" && lines.length < maxLines) lines.push(buffer);
      // 0 = matches, 1 = none, 2 = error (an invalid regex, for instance). A kill is not an error.
      if (code === 2 && !cut && !timedOut && lines.length === 0) reject(new ToolError("bad_pattern", "the pattern or glob is invalid"));
      else resolvePromise(Object.freeze({ lines, cut, timedOut }));
    });
  });
}
