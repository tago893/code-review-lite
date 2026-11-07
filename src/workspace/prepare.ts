import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { redactSecretsDetailed, type RedactionResult } from "../safety/redact.js";
import { WorkspaceError, toWorkspaceError, type WorkspaceErrorCode } from "./errors.js";
import { isExcludedDir, isSafeName, isSensitiveFileName } from "./sensitive.js";

export type SkipReason =
  | "symlink"
  | "sensitive"
  | "unsupported_type"
  | "binary"
  | "not_utf8"
  | "too_large"
  | "unsafe_name";

export interface CopiedFile {
  readonly path: string;
  readonly lines: number;
  readonly redactions: number;
}

export interface SkippedItem {
  readonly path: string;
  readonly reason: SkipReason;
}

export interface PrepareOptions {
  /** The raw checkout. Read only, never modified. */
  readonly sourceDir: string;
  /** An empty directory that becomes the reviewer's /repo. */
  readonly outDir: string;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxDepth?: number;
  /** Replaceable for tests. Must be pure. */
  readonly redact?: (text: string) => RedactionResult;
}

export type PrepareResult =
  | { readonly status: "ready"; readonly copied: readonly CopiedFile[]; readonly skipped: readonly SkippedItem[] }
  | { readonly status: "error"; readonly code: WorkspaceErrorCode };

const DEFAULTS = { maxFileBytes: 1_000_000, maxFiles: 20_000, maxTotalBytes: 200_000_000, maxDepth: 64 } as const;
const BINARY_SNIFF_BYTES = 8192;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Run {
  readonly options: Required<Omit<PrepareOptions, "redact">>;
  readonly redact: (text: string) => RedactionResult;
  readonly sourceRoot: string;
  readonly outRoot: string;
  readonly copied: CopiedFile[];
  readonly skipped: SkippedItem[];
  totalBytes: number;
}

/**
 * Trusted preparation: builds the sanitised snapshot the reviewer sees as /repo. It walks the raw checkout
 * without following links, copies only regular UTF-8 text files, redacts secrets line for line, and leaves out
 * .git, env files, keys, symlinks and anything unusual. It never throws: any failure clears the output and
 * returns an error code, and the caller must not start the agent.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<PrepareResult> {
  let outRoot = options.outDir;
  try {
    const roots = await resolveRoots(options.sourceDir, options.outDir);
    outRoot = roots.outRoot;
    const run: Run = {
      options: { ...DEFAULTS, ...withoutRedact(options) },
      redact: options.redact ?? redactSecretsDetailed,
      sourceRoot: roots.sourceRoot,
      outRoot,
      copied: [],
      skipped: [],
      totalBytes: 0,
    };
    await walk(run, roots.sourceRoot, [], 0);
    return Object.freeze({ status: "ready" as const, copied: Object.freeze(run.copied), skipped: Object.freeze(run.skipped) });
  } catch (error) {
    await clearDir(outRoot);
    return Object.freeze({ status: "error" as const, code: toWorkspaceError(error).code });
  }
}

function withoutRedact(options: PrepareOptions): Omit<PrepareOptions, "redact"> {
  const { redact: _ignored, ...rest } = options;
  return rest;
}

async function resolveRoots(sourceDir: string, outDir: string): Promise<{ sourceRoot: string; outRoot: string }> {
  const sourceRoot = await realpath(sourceDir).catch(() => fail("source_missing"));
  if (!(await lstat(sourceRoot)).isDirectory()) fail("source_not_directory");
  const outParent = await realpath(dirname(resolve(outDir))).catch(() => fail("write_failed"));
  const outRoot = join(outParent, basename(resolve(outDir)));
  if (isInside(outRoot, sourceRoot) || isInside(sourceRoot, outRoot)) fail("out_overlaps_source");
  await mkdir(outRoot, { recursive: true, mode: 0o755 });
  if ((await readdir(outRoot)).length > 0) fail("out_not_empty");
  return { sourceRoot, outRoot };
}

async function walk(run: Run, dir: string, rel: readonly string[], depth: number): Promise<void> {
  if (depth > run.options.maxDepth) fail("limit_exceeded");
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const relParts = [...rel, name];
    if (!isSafeName(name)) {
      skip(run, `#unsafe-name-${run.skipped.length + 1}`, "unsafe_name");
      continue;
    }
    const relPath = relParts.join("/");
    if (redactSecretsDetailed(relPath).findings.length > 0) {
      skip(run, `#unsafe-name-${run.skipped.length + 1}`, "unsafe_name");
      continue;
    }
    await visit(run, join(dir, name), name, relParts, relPath, depth);
  }
}

async function visit(run: Run, full: string, name: string, relParts: readonly string[], relPath: string, depth: number): Promise<void> {
  const info = await lstat(full);
  if (info.isSymbolicLink()) return skip(run, relPath, "symlink");
  if (info.isDirectory()) {
    if (isExcludedDir(name)) return skip(run, relPath, "sensitive");
    return walk(run, full, relParts, depth + 1);
  }
  if (!info.isFile()) return skip(run, relPath, "unsupported_type");
  if (isSensitiveFileName(name) || isExcludedDir(name)) return skip(run, relPath, "sensitive");
  if (info.size > run.options.maxFileBytes) return skip(run, relPath, "too_large");
  await copyFile(run, full, relParts, relPath);
}

async function copyFile(run: Run, full: string, relParts: readonly string[], relPath: string): Promise<void> {
  if (run.copied.length >= run.options.maxFiles) fail("limit_exceeded");
  const bytes = await readRegularFile(full);
  if (bytes === undefined) return skip(run, relPath, "symlink"); // replaced by a link between lstat and open
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return skip(run, relPath, "binary");
  const text = decodeUtf8(bytes);
  if (text === undefined) return skip(run, relPath, "not_utf8");

  const first = guarded(() => run.redact(text));
  const second = guarded(() => run.redact(first.text));
  if (second.text !== first.text) fail("sanitize_failed"); // a second pass still found something: do not trust the first

  run.totalBytes += bytes.length;
  if (run.totalBytes > run.options.maxTotalBytes) fail("limit_exceeded");
  const dest = join(run.outRoot, ...relParts);
  if (!isInside(dest, run.outRoot)) fail("write_failed");
  await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
  await writeFile(dest, first.text, { mode: 0o644, flag: "wx" }).catch(() => fail("write_failed"));
  run.copied.push(Object.freeze({ path: relPath, lines: first.text.split("\n").length, redactions: first.findings.length }));
}

/** Opens without following a final symlink and reads only if it is still a regular file. */
async function readRegularFile(full: string): Promise<Buffer | undefined> {
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ELOOP") return undefined;
    throw e;
  });
  if (!handle) return undefined;
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : undefined;
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Runs the redactor; whatever it throws is replaced by a fixed error so no input text can leak. */
function guarded(fn: () => RedactionResult): RedactionResult {
  try {
    return fn();
  } catch {
    return fail("sanitize_failed");
  }
}

function skip(run: Run, path: string, reason: SkipReason): void {
  run.skipped.push(Object.freeze({ path, reason }));
}

async function clearDir(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
  } catch {
    // Nothing more can be done; the caller still gets the error status and must not start the agent.
  }
}

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);

function fail(code: WorkspaceErrorCode): never {
  throw new WorkspaceError(code);
}
