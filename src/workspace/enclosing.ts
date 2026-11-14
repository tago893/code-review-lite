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
const BRACE_SCAN_LINES = 3_000;
const MAX_LINES_TO_OPEN_BRACE = 3;
const PY_DEFINITION = /^\s*(?:async\s+)?(?:def|class)\s+(\w+)/;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1).)*\1/g;
const FOR_LOOP = /^for[\s(]/;
const KEYWORD_DECLARATION = /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\s/;
const VARIABLE_DECLARATION = /\b(?:const|let|var)\s/;
const FUNCTION_VALUE = /=>|\bfunction\b/;

const extensionOf = (path: string): string => extname(path).toLowerCase();
export const isSupportedSource = (path: string): boolean => extensionOf(path) === ".py" || BRACE_EXTENSIONS.has(extensionOf(path));

const isBlank = (line: string): boolean => line.trim() === "";
const indentOf = (line: string): number => line.length - line.trimStart().length;
const freeze = (name: string, startLine: number, endLine: number): FunctionSpan => Object.freeze({ name, startLine, endLine });

const PY_COMMENT = /#.*$/;
const BRACE_COMMENT = /\/\/.*$/;

/** The line without string literals and the trailing comment, for counting brackets. */
const code = (line: string, comment: RegExp): string => line.replace(STRING_LITERAL, '""').replace(comment, "");

interface PythonHeader {
  readonly endIndex: number;
  /** True when code follows the header's colon on the same line (`def f(): return 1`). */
  readonly oneLiner: boolean;
}

/** Where the header starting at `from` ends: the first colon outside any brackets. */
function pythonHeaderEnd(lines: readonly string[], from: number): PythonHeader {
  let depth = 0;
  for (let i = from; i < lines.length; i++) {
    const text = code(lines[i] ?? "", PY_COMMENT);
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === ":" && depth <= 0) return { endIndex: i, oneLiner: text.slice(c + 1).trim() !== "" };
    }
  }
  return { endIndex: from, oneLiner: true };
}

/** Index of the last body line of the Python definition at `from`. */
function pythonEnd(lines: readonly string[], from: number): number {
  const base = indentOf(lines[from] ?? "");
  const header = pythonHeaderEnd(lines, from);
  if (header.oneLiner) return header.endIndex;
  let last = header.endIndex;
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
function braceEnd(lines: readonly string[], from: number, maxLinesToOpen: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    const text = code(lines[i] ?? "", BRACE_COMMENT);
    for (const ch of text) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
      if (opened && depth <= 0) return i;
    }
    if (!opened && (text.includes(";") || i - from >= maxLinesToOpen)) return undefined;
  }
  return opened ? lines.length - 1 : undefined;
}

interface Declaration {
  readonly name: string;
  readonly maxLinesToOpen: number;
}

/** The function-like declaration on a line, or undefined for loops, object literals and plain calls. */
function declarationOn(line: string): Declaration | undefined {
  if (FOR_LOOP.test(line.trim())) return undefined;
  const name = declaredSymbols(line)[0];
  if (name === undefined) return undefined;
  if (!KEYWORD_DECLARATION.test(line)) return { name, maxLinesToOpen: 0 };
  if (VARIABLE_DECLARATION.test(line) && !FUNCTION_VALUE.test(line)) return undefined;
  return { name, maxLinesToOpen: MAX_LINES_TO_OPEN_BRACE };
}

function braceEnclosing(lines: readonly string[], lineNo: number): FunctionSpan | undefined {
  const target = Math.min(lineNo, lines.length) - 1;
  for (let i = target; i >= 0 && target - i <= BRACE_SCAN_LINES; i--) {
    const declaration = declarationOn(lines[i] ?? "");
    if (declaration === undefined) continue;
    const { name, maxLinesToOpen } = declaration;
    const end = braceEnd(lines, i, maxLinesToOpen);
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
