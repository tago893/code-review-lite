import { DiffParseError } from "./errors.js";

const PREFIX_ERROR =
  "expected paths prefixed with a/ and b/ (generate the diff with git's default prefixes, not --no-prefix or mnemonic prefixes)";

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34,
};

const OCTAL_DIGIT = /[0-7]/;

export interface QuotedString {
  readonly value: string;
  /** Index just after the closing quote. */
  readonly next: number;
}

/** Decodes a C-style quoted string as git writes unusual file names: \t \" \\ and \NNN octal UTF-8 bytes. */
export function readQuoted(text: string, start: number, line: number): QuotedString {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      return { value: new TextDecoder().decode(Uint8Array.from(bytes)), next: i + 1 };
    }
    if (ch !== "\\") {
      const char = String.fromCodePoint(text.codePointAt(i)!);
      bytes.push(...encoder.encode(char));
      i += char.length;
      continue;
    }
    const escaped = text[i + 1];
    if (escaped !== undefined && OCTAL_DIGIT.test(escaped)) {
      let end = i + 1;
      while (end < text.length && end - (i + 1) < 3 && OCTAL_DIGIT.test(text[end]!)) end++;
      bytes.push(parseInt(text.slice(i + 1, end), 8) & 0xff);
      i = end;
      continue;
    }
    const code = escaped === undefined ? undefined : SIMPLE_ESCAPES[escaped];
    if (code === undefined) throw new DiffParseError("invalid escape in quoted path", line);
    bytes.push(code);
    i += 2;
  }
  throw new DiffParseError("unterminated quoted path", line);
}

function requirePrefix(path: string, prefix: "a/" | "b/", line: number): string {
  if (!path.startsWith(prefix)) throw new DiffParseError(PREFIX_ERROR, line);
  return path.slice(prefix.length);
}

/** A path as it appears after `rename from` / `rename to`: quoted, or bare (spaces allowed). */
export function parseBareOrQuoted(value: string, line: number): string {
  return value.startsWith('"') ? readQuoted(value, 0, line).value : value;
}

/**
 * The value of a `--- ` or `+++ ` line. Returns null for /dev/null. Git appends a tab to unquoted names
 * that contain spaces; unquoted names never contain a tab, so everything from the first tab is dropped.
 */
export function parseFileNameLine(value: string, prefix: "a/" | "b/", line: number): string | null {
  const name = value.startsWith('"') ? readQuoted(value, 0, line).value : (value.split("\t")[0] ?? "");
  if (name === "/dev/null") return null;
  return requirePrefix(name, prefix, line);
}

export interface HeaderPaths {
  readonly oldPath: string;
  readonly newPath: string;
}

/**
 * Paths from `diff --git a/OLD b/NEW` (the text after `diff --git `). Unquoted names can contain
 * spaces, so an unquoted header is only decodable when old and new are identical; for a rename it
 * returns null and the caller uses the `rename from` / `rename to` lines instead.
 */
export function parseDiffGitHeader(rest: string, line: number): HeaderPaths | null {
  if (!rest.startsWith("a/") && !rest.startsWith('"a/')) throw new DiffParseError(PREFIX_ERROR, line);
  if (rest.startsWith('"')) return parseQuotedHeader(rest, line);
  for (let i = rest.indexOf(" "); i !== -1; i = rest.indexOf(" ", i + 1)) {
    const right = rest.slice(i + 1);
    if (!right.startsWith("b/") && !right.startsWith('"b/')) continue;
    const rightPath = right.startsWith('"') ? readQuoted(right, 0, line).value.slice(2) : right.slice(2);
    const leftPath = rest.slice(2, i);
    if (leftPath === rightPath) return { oldPath: leftPath, newPath: rightPath };
  }
  return null;
}

function parseQuotedHeader(rest: string, line: number): HeaderPaths {
  const first = readQuoted(rest, 0, line);
  const remainder = rest.slice(first.next).replace(/^ /, "");
  const second = remainder.startsWith('"') ? readQuoted(remainder, 0, line).value : remainder;
  return { oldPath: requirePrefix(first.value, "a/", line), newPath: requirePrefix(second, "b/", line) };
}
