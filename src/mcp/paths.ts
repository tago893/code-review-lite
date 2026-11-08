import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isSensitivePath } from "../workspace/sensitive.js";
import { LIMITS } from "./limits.js";

/** A refused or failed tool call. `code` is a fixed word; the message never carries file content. */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export interface Roots {
  /** Relative paths resolve against this root: the sanitised snapshot at /repo. */
  readonly primary: string;
  /** Other read-only roots a model may name by absolute path, e.g. /review/context. */
  readonly extra: readonly string[];
}

export interface Resolved {
  /** Absolute path, with no symlink anywhere in it. */
  readonly abs: string;
  /** The root it lies under. */
  readonly root: string;
  /** How to show it: relative to the primary root, otherwise absolute. */
  readonly shown: string;
}

const hasNul = (value: string): boolean => value.includes("\0");

/**
 * Turns a requested path into a real path inside one allowed root, or throws a ToolError.
 * - `..` and absolute paths are resolved first, then checked against the roots, so traversal cannot leave them.
 * - Symlinks are refused outright: the path must equal its own realpath. The snapshot has none; a symlink here is
 *   either a bug or an escape attempt, and following it is never needed.
 * - Names that the snapshot builder withholds (env files, keys, ...) are refused again here.
 */
export function resolveWithin(roots: Roots, requested: string | undefined): Resolved {
  const wanted = requested === undefined || requested.trim() === "" ? "." : requested.trim();
  if (hasNul(wanted) || wanted.length > LIMITS.maxPathChars) throw new ToolError("bad_path", "path is empty, too long or contains a NUL byte");
  const primary = realRoot(roots.primary);
  const candidate = resolve(primary, wanted);
  const allRoots = [primary, ...roots.extra.flatMap((r) => { try { return [realRoot(r)]; } catch { return []; } })];
  const root = allRoots.find((r) => candidate === r || candidate.startsWith(r + sep));
  if (root === undefined) throw new ToolError("outside_roots", "path is outside the repository snapshot and the review context");

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ToolError("not_found", "no such file or directory");
  }
  if (real !== candidate) throw new ToolError("symlink", "symbolic links are not followed");
  if (real !== root && !real.startsWith(root + sep)) throw new ToolError("outside_roots", "path is outside the allowed roots");
  const rel = relative(root, real);
  if (rel !== "" && isSensitivePath(rel)) throw new ToolError("withheld", "this path is withheld from reviewers");
  const shown = root === primary ? (rel === "" ? "." : rel) : real;
  return Object.freeze({ abs: real, root, shown });
}

/** A root is trusted configuration, but a symlinked root would silently widen the fence, so it is resolved once. */
function realRoot(root: string): string {
  if (!isAbsolute(root)) throw new ToolError("bad_root", "roots must be absolute");
  return realpathSync(root);
}

export function isRegularFile(abs: string): boolean {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(abs: string): boolean {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}
