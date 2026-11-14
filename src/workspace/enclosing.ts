import { extname } from "node:path";
import { declaredSymbols } from "../verify/relation.js";

/** A function or class in a source file. Lines are 1-based and inclusive. */
export interface FunctionSpan {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

const BRACE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".kt", ".swift", ".php", ".scala",
]);
const BRACE_SCAN_LINES = 400;
const MAX_LINES_TO_OPEN_BRACE = 3;
const PY_DEFINITION = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/;
const STRING_LITERAL = /(["'`])(?:\.|(?!\1).)*\1/g;

const extensionOf = (path: string): string => extname(path).toLowerCase();
export const isSupportedSource = (path: string): boolean => extensionOf(path) === ".py" || BRACE_EXTENSIONS.has(extensionOf(path));

const isBlank = (line: string): boolean => line.trim() === "";
const indentOf = (line: string): number => line.length - line.trimStart().length;
const freeze = (name: string, startLine: number, endLine: number): FunctionSpan => Object.freeze({ name, startLine, endLine });

const PY_COMMENT = /#.*$/;
const BRACE_COMMENT = /\/\/.*$/;

/** The line without string literals and the trailing comment, for counting brackets. */
const code = (line: string, comment: RegExp): string => line.replace(STRING_LITERAL, '""').replace(comment, "");

/** Index of the line where the signature starting at `from` ends: parentheses balanced and the line ends with ":". */
function pythonSignatureEnd(lines: readonly string[], from: number): number {
  let depth = 0;
  for (let i = from; i < lines.length; i++) {
    const text = code(lines[i] ?? "", PY_COMMENT);
    for (const ch of text) depth += ch === "(" || ch === "[" ? 1 : ch === ")" || ch === "]" ? -1 : 0;
    if (depth <= 0 && text.trimEnd().endsWith(":")) return i;
  }
  return from;
}

/** Index of the last body line of the Python definition at `from`. */
function pythonEnd(lines: readonly string[], from: number): number {
  const base = indentOf(lines[from] ?? "");
  let last = pythonSignatureEnd(lines, from);
  for (let i = last + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isBlank(line)) continue;
    if (indentOf(line) <= base) break;
    last = i;
  }
  return last;
}

function pythonEnclosing(lines: readonly string[], lineNo: number): FunctionSpan | undefined {
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const name = PY_DEFINITION.exec(lines[i] ?? "")?.[1];
    if (name === undefined) continue;
    const end = pythonEnd(lines, i);
    if (end + 1 >= lineNo) return freeze(name, i + 1, end + 1);
  }
  return undefined;
}

/** Index of the line where the brace block declared at `from` closes, or undefined if no block opens there. */
function braceEnd(lines: readonly string[], from: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    const text = code(lines[i] ?? "", BRACE_COMMENT);
    for (const ch of text) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
      if (opened && depth <= 0) return i;
    }
    if (!opened && (text.includes(";") || i - from >= MAX_LINES_TO_OPEN_BRACE)) return undefined;
  }
  return opened ? lines.length - 1 : undefined;
}

function braceEnclosing(lines: readonly string[], lineNo: number): FunctionSpan | undefined {
  const target = Math.min(lineNo, lines.length) - 1;
  for (let i = target; i >= 0 && target - i <= BRACE_SCAN_LINES; i--) {
    const name = declaredSymbols(lines[i] ?? "")[0];
    if (name === undefined) continue;
    const end = braceEnd(lines, i);
    if (end !== undefined && end >= target) return freeze(name, i + 1, end + 1);
  }
  return undefined;
}

/** The function or class that contains `lineNo` (1-based), or undefined at file level or for unsupported files. */
export function enclosingFunction(path: string, lines: readonly string[], lineNo: number): FunctionSpan | undefined {
  if (lineNo < 1 || lines.length === 0) return undefined;
  const ext = extensionOf(path);
  if (ext === ".py") return pythonEnclosing(lines, lineNo);
  return BRACE_EXTENSIONS.has(ext) ? braceEnclosing(lines, lineNo) : undefined;
}
