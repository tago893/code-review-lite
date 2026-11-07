// Deterministic detectors for independent confirmation. Pure functions over source lines and a diff entry.
// They look for a concrete code pattern at the cited location; they do not prove the code is exploitable.

import type { DiffEntry } from "../types.js";

const LITERAL = "\u0001"; // stands in for a string literal after its contents are masked

const SQL_STATEMENT =
  /\b(select\b[^;]*\bfrom\b|insert\s+into\b|update\b[^;]*\bset\b|delete\s+from\b|where\s+[\w."`]+\s*(?:=|<|>|like\b|in\b))/i;
const QUERY_CALL = /\b(?:query|execute|executemany|exec|raw|queryRaw\w*|executeRaw\w*|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(/;

/** Replaces every quoted string with a placeholder so operators between strings and identifiers can be seen. */
function maskLiterals(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, LITERAL);
}

/** True when `text` builds SQL from a string literal plus a non-literal value (concatenation, template, f-string, % or format). */
export function buildsSqlDynamically(text: string): boolean {
  const literals = text.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g) ?? [];
  if (!literals.some((l) => SQL_STATEMENT.test(l)) && !SQL_STATEMENT.test(text)) return false;
  const masked = maskLiterals(text);
  const concat = new RegExp(`${LITERAL}\\s*\\+\\s*[A-Za-z_$(\\[]|[A-Za-z_$)\\]]\\s*\\+\\s*${LITERAL}`).test(masked);
  const template = /(?<![\w$.)\]])`[^`]*\$\{[^`]*`/.test(text) && literals.some((l) => l.startsWith("`") && SQL_STATEMENT.test(l));
  const fString = /\bf(["'])[^"'\n]*\{[^}\n]+\}[^"'\n]*\1/.test(text) && SQL_STATEMENT.test(text);
  const percent = new RegExp(`${LITERAL}\\s*%\\s*[\\w(]`).test(masked) && SQL_STATEMENT.test(text);
  const format = new RegExp(`${LITERAL}\\s*\\.format\\(`).test(masked) && SQL_STATEMENT.test(text);
  return concat || template || fString || percent || format;
}

/** SQL built dynamically and passed to a query call, in one statement window or through a variable nearby. */
export function sqlConcatReachesQuery(lines: readonly string[], cited: number): boolean {
  const at = (from: number, to: number): string => lines.slice(Math.max(0, from - 1), Math.min(lines.length, to)).join("\n");
  const near = at(cited - 2, cited + 2);
  if (QUERY_CALL.test(near) && buildsSqlDynamically(near)) return true;

  const wide = lines.slice(Math.max(0, cited - 9), Math.min(lines.length, cited + 8));
  for (const line of wide) {
    const assign = /^\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*\+?=\s*(.+)$/.exec(line);
    if (!assign || !buildsSqlDynamically(assign[2] ?? "")) continue;
    const name = (assign[1] ?? "").replace(/\$/g, "\\$");
    const reaches = new RegExp(`\\b(?:query|execute|executemany|exec|raw)\\s*\\(\\s*${name}\\b`);
    if (wide.some((l) => reaches.test(l))) return true;
  }
  return false;
}

// --- removed authentication / validation on a route -------------------------------------------------------

const AUTH_OR_VALIDATION =
  /\b(isAdmin|is_admin|requireAuth\w*|require_auth\w*|requireLogin|authenticate\w*|authorize\w*|isAuthenticated|is_authenticated|checkPermission\w*|hasPermission|hasRole|has_role|verifyToken|verify_token|login_required|permission_required|PreAuthorize|Secured|RolesAllowed|ensureLoggedIn|checkAuth\w*|csrf\w*|validate\w*|sanitize\w*)\b/i;
const ROUTE_PATH = /(^|\/)(routes?|controllers?|handlers?|api|views|endpoints|resolvers|middleware)(\/|\.|$)/i;
const ROUTE_CODE =
  /\b(app|router|server|api)\.(get|post|put|patch|delete|use|all)\s*\(|@(app|router|bp|blueprint)\.(route|get|post|put|delete)\b|@(Get|Post|Put|Patch|Delete|Request)Mapping\b|@route\b/i;

export const isRouteFile = (path: string, lines: readonly string[]): boolean =>
  ROUTE_PATH.test(path) || lines.some((l) => ROUTE_CODE.test(l));

interface Hunk {
  readonly start: number;
  readonly length: number;
  removedAuth: number;
  addedAuth: number;
}

function hunksOf(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunks.push({ start: Number(header[1]), length: header[2] === undefined ? 1 : Number(header[2]), removedAuth: 0, addedAuth: 0 });
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (!hunk) continue;
    if (line.startsWith("-") && AUTH_OR_VALIDATION.test(line)) hunk.removedAuth++;
    else if (line.startsWith("+") && AUTH_OR_VALIDATION.test(line)) hunk.addedAuth++;
  }
  return hunks;
}

/** A hunk near the cited line removed more auth/validation lines than it added (a moved check does not count). */
export function removedAuthCheck(entry: DiffEntry, cited: number): boolean {
  return hunksOf(entry.patch).some(
    (h) => h.removedAuth > h.addedAuth && cited >= h.start - 3 && cited <= h.start + h.length + 2,
  );
}

// --- query or HTTP call inside a loop -----------------------------------------------------------------------

const REMOTE_CALL =
  /\.(?:query|execute|exec|findOne|findById|findUnique|findFirst|findMany)\s*\(|\bfetch\s*\(|\baxios\b[.(]|\brequests\.(?:get|post|put|delete|patch)\s*\(|\bhttp\.(?:get|request)\s*\(|\burlopen\s*\(/;
const LOOP_HEADER = /^\s*(?:for|while)\b|^\s*do\s*\{|\.(?:forEach|map|flatMap|reduce|each)\s*\(/;
const FUNCTION_HEADER = /^\s*(?:export\s+)?(?:async\s+)?(?:function\b|def\b|class\b)|^\s*(?:public|private|protected|static)\b.*\)\s*\{\s*$/;
const MAX_LOOK_BACK = 60;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isCloser = (line: string): boolean => /^\s*[}\])]/.test(line);

/** A query or HTTP call within 2 lines of the cited one that sits inside a loop or an iteration callback. */
export function queryInLoop(lines: readonly string[], cited: number): boolean {
  for (let n = Math.max(1, cited - 2); n <= Math.min(lines.length, cited + 2); n++) {
    const line = lines[n - 1] ?? "";
    const call = REMOTE_CALL.exec(line);
    if (call && (loopBefore(line, call.index) || enclosedByLoop(lines, n))) return true;
  }
  return false;
}

function loopBefore(line: string, callIndex: number): boolean {
  return /(?:\bfor\b|\bwhile\b|\.(?:forEach|map|flatMap|reduce|each)\s*\()/.test(line.slice(0, callIndex));
}

function enclosedByLoop(lines: readonly string[], n: number): boolean {
  let current = indentOf(lines[n - 1] ?? "");
  for (let i = n - 1; i >= 1 && i >= n - MAX_LOOK_BACK; i--) {
    const line = lines[i - 1] ?? "";
    if (line.trim() === "" || isCloser(line)) continue;
    const indent = indentOf(line);
    if (indent >= current) continue;
    if (LOOP_HEADER.test(line)) return true;
    if (FUNCTION_HEADER.test(line)) return false;
    current = indent;
    if (current === 0) return false;
  }
  return false;
}
