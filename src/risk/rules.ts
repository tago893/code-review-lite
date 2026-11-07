import { isTestPath } from "./paths.js";
import type { DiffEntry } from "../types.js";
import type { SignalFamily } from "./types.js";

// Content rules: a table of deterministic checks over a file's added and removed lines. Each rule
// returns at most one hit per file. All patterns are plain regular expressions, never executed code.

export interface ChangedLine {
  readonly text: string;
  readonly line: number;
}

export interface RuleContext {
  readonly entry: DiffEntry;
  readonly added: readonly ChangedLine[];
  readonly removed: readonly ChangedLine[];
  readonly isTest: boolean;
}

export interface RuleHit {
  readonly reason: string;
  readonly line?: number;
  /** The matched line, trimmed and truncated. */
  readonly evidence?: string;
}

const EVIDENCE_LIMIT = 120;

export interface ContentRule {
  readonly signal: string;
  readonly family: SignalFamily;
  readonly detect: (context: RuleContext) => RuleHit | undefined;
}

type LineTest = (text: string) => boolean;

const matches = (...patterns: readonly RegExp[]): LineTest => (text) => patterns.some((p) => p.test(text));
const all = (...tests: readonly LineTest[]): LineTest => (text) => tests.every((t) => t(text));
const first = (lines: readonly ChangedLine[], test: LineTest): ChangedLine | undefined =>
  lines.find((l) => test(l.text));
const count = (lines: readonly ChangedLine[], test: LineTest): number =>
  lines.filter((l) => test(l.text)).length;

const hitAt = (reason: string, found: ChangedLine | undefined): RuleHit | undefined =>
  found === undefined ? undefined : { reason, line: found.line, evidence: found.text.trim().slice(0, EVIDENCE_LIMIT) };

interface Options {
  /** Skip files that are tests: the pattern is risky in production code, not in test fixtures. */
  readonly skipTests?: boolean;
}

/** Fires when a line matching `test` is ADDED. */
function onAdded(signal: string, family: SignalFamily, reason: string, test: LineTest, options: Options = {}): ContentRule {
  return {
    signal, family,
    detect: (c) => (options.skipTests && c.isTest ? undefined : hitAt(reason, first(c.added, test))),
  };
}

/** Fires when a matching line is added or removed. */
function onEither(signal: string, family: SignalFamily, reason: string, test: LineTest, options: Options = {}): ContentRule {
  return {
    signal, family,
    detect: (c) =>
      options.skipTests && c.isTest ? undefined : hitAt(reason, first(c.added, test) ?? first(c.removed, test)),
  };
}

/** Fires when more matching lines were removed than added: a safeguard was dropped, not edited in place. */
function onNetRemoval(signal: string, family: SignalFamily, reason: string, test: LineTest, testsOnly = false): ContentRule {
  return {
    signal, family,
    detect: (c) => {
      if (testsOnly && !c.isTest) return undefined;
      return count(c.removed, test) > count(c.added, test) ? hitAt(reason, first(c.removed, test)) : undefined;
    },
  };
}

// ---- dangerous sinks ------------------------------------------------------------------------------

const SQL_STATEMENT = matches(
  /\bselect\b[^;]*\bfrom\b/i, /\binsert\s+into\b/i, /\bupdate\b[^;]*\bset\b/i,
  /\bdelete\s+from\b/i, /\b(drop|alter)\s+table\b/i,
);
const STRING_BUILDING = matches(/["'`]\s*\+/, /\+\s*["'`]/, /\$\{/, /\bf["']/, /\.format\s*\(/, /["']\s*%\s*[\w(]/);
const SHELL_EXEC = matches(
  /(^|[^.\w])(exec|execSync|execFile|spawn|spawnSync|system|popen)\s*\(/, /\bchild_process\b/,
  /\bsubprocess\.\w+\s*\(/, /\bos\.(system|popen)\s*\(/, /shell\s*=\s*True/, /Runtime\.getRuntime\(\)\.exec/,
);
const PATH_CALL = matches(/\b(?:path\.(?:join|resolve)|os\.path\.join|Paths\.get|Path)\s*\(/);
const USER_INPUT_WORD = matches(/\b(req|request|params|query|body|input|argv|args)\b/);
const HTTP_CALL_WITH_VARIABLE_URL = matches(
  /\b(?:fetch|axios(?:\.\w+)?|got|requests\.(?:get|post|put|delete|patch|request)|urlopen|https?\.(?:get|request))\s*\(\s*(?:[A-Za-z_$][\w$.[\]]*\s*[,)+]|`[^`]*\$\{)/,
);

// ---- weakened safeguards --------------------------------------------------------------------------

const AUTH_IDENTIFIER = matches(
  /\b(is_?admin|is_?authenticated|is_?authorized|is_?staff|has_?permission|has_?role|has_?access|check_?permission)\b/i,
  /\b(require_?auth\w*|login_required|authori[sz]e\w*|permission\w*|forbidden|unauthori[sz]ed|access_?denied)\b/i,
);
const GUARD_WORD = matches(
  /\b(if|unless|assert|throw|raise|return|abort|deny|reject|guard|require|forbid)\b/i,
  /@\w*(Auth|Permission|Role|Secured)/i,
);
const AUTH_CHECK = all(AUTH_IDENTIFIER, GUARD_WORD);
const VALIDATION = matches(/\b(?:validate\w*|validator|sanitiz\w*|sanitis\w*|escape\w*|isValid|is_valid|csrf\w*)\b/i);
const ERROR_HANDLING = matches(/\b(?:catch|except|rescue)\b/);
const RESILIENCE = matches(/\b(?:timeout|retry|retries|backoff|rate[_-]?limit\w*|throttle\w*|max_?attempts)\b/i);
const TEST_SKIP = matches(
  /\b(?:describe|it|test|context)\.skip\s*\(/, /\bx(?:it|describe|test)\s*\(/, /\bit\.todo\s*\(/,
  /@pytest\.mark\.(?:skip|xfail)/, /\bpytest\.skip\s*\(/, /@(?:Ignore|Disabled)\b/, /\bt\.Skip(?:Now)?\s*\(/,
  /\bunittest\.skip/,
);
const ANY_SKIP = matches(/\.skip\s*\(/);
const ASSERTION = matches(/\b(?:expect|assert\w*|should|verify)\b\s*[(.]/);

// ---- concurrency and state ------------------------------------------------------------------------

const LOCKING = matches(
  /\b(?:mutex|rwmutex|reentrantlock|semaphore|atomicinteger|atomiclong)\b/i, /\.(?:Lock|Unlock|RLock|RUnlock)\s*\(\s*\)/,
  /\bsynchronized\b/, /\bthreading\.(?:Lock|RLock|Semaphore)\b/, /\basyncio\.(?:Lock|Semaphore)\b/,
  /\bwith\s+\w*lock\w*\s*:/i, /\bFOR\s+UPDATE\b/, /\batomic\./, /\bvolatile\b/,
);
const TRANSACTION = matches(
  /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/, /START\s+TRANSACTION/i, /\.transaction\s*\(/,
  /\b(?:beginTransaction|begin_transaction)\b/, /@Transactional\b/, /\.(?:commit|rollback)\s*\(\s*\)/,
  /\btransaction\.atomic\b/,
);
const CACHE = matches(
  /\bcache\w*\.(?:set|put|delete|del|clear|invalidate|flush|evict|expire)\s*\(/i, /\b(?:invalidate|evict|purge|flush|clear)_?cache/i,
  /@Cache(?:Evict|Put|able)\b/, /\.(?:setex|expire|pexpire)\s*\(/, /\blru_cache\b/,
);
const JS_FILE = /\.[cm]?[jt]sx?$/;
const PY_FILE = /\.py$/;
const MODULE_LET = matches(/^(?:export\s+)?(?:let|var)\s+\w+/);
const MODULE_GLOBAL = matches(/^\s*global\s+\w+/);
const ASYNC_MARKER = matches(/\b(?:await|async)\b/, /Promise\.(?:all|race|allSettled)\b/, /\bgo\s+func\b/);

// ---- performance ----------------------------------------------------------------------------------

const LOOP_START = matches(/\b(?:for|while)\b/, /\.(?:forEach|map|flatMap)\s*\(/);
const IO_CALL = matches(
  /\b(?:db|conn|connection|client|cursor|session|repo|repository|http|axios|requests|prisma|knex|sql)\w*\.\w+\s*\(/i,
  /\b(?:query|execute|fetch|findOne|findAll|findMany|findUnique|select)\s*\(/i,
);
const INDEX_OR_CACHE = matches(
  /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /\badd_index\b/, /\bcreateIndex\b/, /@Index\b/, /\bindex:\s*true/,
  /@lru_cache/, /@Cacheable/, /\bmemoize\b/i, /functools\.cache/,
);
const INDEX_DROPPED = matches(/DROP\s+INDEX/i, /\bremove_index\b/, /\bdropIndex\b/);
const LOOP_WINDOW = 5;

function ioInLoop(c: RuleContext): RuleHit | undefined {
  for (let i = 0; i < c.added.length; i++) {
    const start = c.added[i]!;
    if (!LOOP_START(start.text)) continue;
    let previous = start.line;
    if (IO_CALL(start.text)) return hitAt("loop performs I/O (query or request) on each iteration", start);
    for (const next of c.added.slice(i + 1, i + 1 + LOOP_WINDOW)) {
      if (next.line !== previous + 1) break;
      if (IO_CALL(next.text)) return hitAt("loop performs I/O (query or request) on each iteration", start);
      previous = next.line;
    }
  }
  return undefined;
}

// ---- contract changes -----------------------------------------------------------------------------

const DECLARATIONS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*(\([^)]*\))/,
  /^\s*export\s+(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\))\s*(?::[^=]+)?=>/,
  /^\s*def\s+([A-Za-z]\w*)\s*(\([^)]*\))/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*(\([^)]*\))/,
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?(\([^)]*\))/,
  /^\s*public\s+(?:static\s+)?(?:final\s+)?[\w<>[\],.? ]+\s+(\w+)\s*(\([^)]*\))/,
];

function declarations(lines: readonly ChangedLine[]): Map<string, { params: string; line: number }> {
  const found = new Map<string, { params: string; line: number }>();
  for (const l of lines) {
    for (const pattern of DECLARATIONS) {
      const m = pattern.exec(l.text);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        found.set(m[1], { params: m[2].replace(/\s+/g, " ").trim(), line: l.line });
        break;
      }
    }
  }
  return found;
}

function publicSignatureChanged(c: RuleContext): RuleHit | undefined {
  const before = declarations(c.removed);
  const after = declarations(c.added);
  for (const [name, old] of before) {
    const now = after.get(name);
    if (now === undefined) return { reason: `public function ${name} was removed or renamed`, line: old.line };
    if (now.params !== old.params) {
      return { reason: `parameters of public function ${name} changed: ${old.params} -> ${now.params}`, line: now.line };
    }
  }
  return undefined;
}

function dependencyLineChanged(c: RuleContext): RuleHit | undefined {
  const looksLikeDependency = matches(/"[^"]+"\s*:\s*"(?:[\^~<>=*]*\d|latest|git|https?:|file:|npm:|workspace:)/);
  const notPackageMetadata: LineTest = (text) => !/^\s*"(?:version|name)"\s*:/.test(text);
  const changed = first(c.added, all(looksLikeDependency, notPackageMetadata))
    ?? first(c.removed, all(looksLikeDependency, notPackageMetadata));
  return hitAt("a dependency version or source changed in package.json", changed);
}

export const PACKAGE_JSON_RULE: ContentRule = {
  signal: "dependency_manifest",
  family: "contract_change",
  detect: dependencyLineChanged,
};

// ---- the table ------------------------------------------------------------------------------------

export const CONTENT_RULES: readonly ContentRule[] = [
  onAdded("sql_string_building", "dangerous_sink", "SQL is built from strings, which risks injection", all(SQL_STATEMENT, STRING_BUILDING), { skipTests: true }),
  onAdded("shell_exec", "dangerous_sink", "runs a shell command or subprocess", SHELL_EXEC, { skipTests: true }),
  onAdded("dynamic_code_eval", "dangerous_sink", "evaluates dynamic code", matches(/(^|[^.\w])eval\s*\(/, /\bnew\s+Function\s*\(/), { skipTests: true }),
  onAdded("unsafe_deserialization", "dangerous_sink", "deserializes data with an unsafe loader", matches(/\bpickle\.loads?\s*\(/, /\byaml\.load\s*\((?![^)]*SafeLoader)/, /\bObjectInputStream\b/, /\bunserialize\s*\(/, /\bmarshal\.loads?\s*\(/, /\bBinaryFormatter\b/), { skipTests: true }),
  onAdded("html_injection", "dangerous_sink", "writes unescaped HTML into the page", matches(/\.(?:innerHTML|outerHTML)\s*=[^=]/, /dangerouslySetInnerHTML/, /\bdocument\.write(?:ln)?\s*\(/, /\binsertAdjacentHTML\s*\(/, /\bv-html\b/, /\|\s*safe\b/, /\bmark_safe\s*\(/, /\bbypassSecurityTrust\w*/), { skipTests: true }),
  onAdded("path_from_user_input", "dangerous_sink", "builds a file path from request-like input", all(PATH_CALL, USER_INPUT_WORD), { skipTests: true }),
  onAdded("outbound_http_variable_url", "dangerous_sink", "makes an outbound request to a URL held in a variable", HTTP_CALL_WITH_VARIABLE_URL, { skipTests: true }),
  onAdded("file_write", "dangerous_sink", "writes to the file system", matches(/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|write_text|write_bytes)\s*\(/, /\bopen\s*\([^)]*,\s*["'][wa]/), { skipTests: true }),

  onNetRemoval("auth_check_removed", "weakened_safeguard", "an authorisation or permission check was removed", AUTH_CHECK),
  onNetRemoval("validation_removed", "weakened_safeguard", "input validation or sanitising was removed", VALIDATION),
  onNetRemoval("error_handling_removed", "weakened_safeguard", "error handling (catch/except/rescue) was removed", ERROR_HANDLING),
  onNetRemoval("resilience_removed", "weakened_safeguard", "a timeout, retry or rate limit was removed", RESILIENCE),
  {
    signal: "test_deleted", family: "weakened_safeguard",
    detect: (c) => (c.entry.status === "deleted" && c.isTest ? { reason: "a test file was deleted" } : undefined),
  },
  {
    signal: "test_skipped", family: "weakened_safeguard",
    // In a test file any `.skip(` counts; elsewhere only recognisable test-skip forms, so iterator
    // `.skip(n)` calls in production code are not mistaken for skipped tests.
    detect: (c) => hitAt("a test was skipped or disabled", first(c.added, c.isTest ? (t) => TEST_SKIP(t) || ANY_SKIP(t) : TEST_SKIP)),
  },
  onNetRemoval("assertions_removed", "weakened_safeguard", "test assertions were removed", ASSERTION, true),

  onEither("lock_or_sync_changed", "concurrency_state", "locking or synchronisation changed", LOCKING, { skipTests: true }),
  onEither("transaction_changed", "concurrency_state", "transaction handling changed", TRANSACTION, { skipTests: true }),
  onEither("cache_changed", "concurrency_state", "cache writes or invalidation changed", CACHE, { skipTests: true }),
  {
    // `let`/`var` at column 0 is module-level state only in JS/TS; in Rust or Go it is an ordinary local.
    signal: "shared_mutable_state", family: "concurrency_state",
    detect: (c) =>
      !c.isTest && (JS_FILE.test(c.entry.newPath) || PY_FILE.test(c.entry.newPath))
        ? hitAt("adds module-level mutable state", first(c.added, JS_FILE.test(c.entry.newPath) ? MODULE_LET : MODULE_GLOBAL))
        : undefined,
  },
  {
    signal: "async_flow_changed", family: "concurrency_state",
    detect: (c) =>
      !c.isTest && count(c.added, ASYNC_MARKER) !== count(c.removed, ASYNC_MARKER)
        ? hitAt("the number of await/async points changed, which changes ordering", first(c.added, ASYNC_MARKER) ?? first(c.removed, ASYNC_MARKER))
        : undefined,
  },

  { signal: "public_signature_changed", family: "contract_change", detect: (c) => (c.isTest ? undefined : publicSignatureChanged(c)) },

  { signal: "io_in_loop", family: "performance", detect: (c) => (c.isTest ? undefined : ioInLoop(c)) },
  {
    signal: "index_or_cache_removed", family: "performance",
    detect: (c) =>
      count(c.removed, INDEX_OR_CACHE) > count(c.added, INDEX_OR_CACHE)
        ? hitAt("an index or cache was removed", first(c.removed, INDEX_OR_CACHE))
        : hitAt("an index was dropped", first(c.added, INDEX_DROPPED)),
  },
];

export function toContext(entry: DiffEntry): RuleContext {
  return {
    entry,
    added: entry.addedLines.map((text, i) => ({ text, line: entry.addedLineNumbers[i] ?? 0 })),
    removed: entry.removedLines.map((text, i) => ({ text, line: entry.removedLineNumbers[i] ?? 0 })),
    isTest: isTestPath(entry.newPath) || isTestPath(entry.oldPath),
  };
}
