# Change Map ("what changed" prep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any reviewer runs, the trusted prep step finds the function each changed line sits in and the places that call it, and puts a short summary plus caller code into the reviewer's shared context.

**Architecture:** Two new prep-side modules under `src/workspace/`: `enclosing.ts` (which function contains line N: indentation rules for Python, brace matching for C-like languages) and `change-map.ts` (diff entries + sanitized snapshot -> `ChangeMap`, and `ChangeMap` -> prompt text). `src/cli/prepare.ts` builds the map after the snapshot is copied; `writeReviewContext` writes `change-map.json` and inserts the text into `shared-context.txt` ahead of the diff. The lean reviewer already sends `shared-context.txt` to the model, so the reviewer side needs no change.

**Tech Stack:** TypeScript (strict, ESM with `.js` import suffixes), Node 22, vitest. No new dependencies.

**Spec:** inline below. Agreed with the user on 2026-11-13 as step 1 of the CRA build order (the stage plan lives in the user's notes). Source idea: the "Parent Function" context from arXiv 2505.17928, plus callers found by grep (the part uReview does not have).

### Spec

- Build one deterministic "what changed" artifact on the trusted side, before the model runs, from the reviewed diff entries and the sanitized snapshot (never the raw checkout).
- For each changed line: its enclosing function (name, first line, last line).
- For each changed function: its callers found by text search, each with the caller's enclosing function and line range.
- Small slices of caller code go into the reviewer prompt; the rest stays readable with `cra_read`.
- **Acceptance (Case 001,** repo `C:\Users\varun\cra-runs\case001-repo`, base `b70fc05`, head `63f9aa5`): `get_hold` (`app/services/hold_service.py:90-102`) is reported as changed and linked to its caller at `app/services/booking_service.py:29`, inside `confirm`, lines 28-51.

## Global Constraints

- Prep side only: no model calls, no network. Read files only from the sanitized snapshot directory (`cmd.outRepo`).
- Deterministic: the same diff and snapshot give byte-identical `change-map.json` and prompt text (every list sorted).
- Project style: `readonly` fields, frozen results, no mutation of inputs. Files under 400 lines, functions under 50 lines.
- Constants, in `src/workspace/change-map.ts` unless noted: `MAX_CHANGED_FUNCTIONS = 12`, `MAX_CALLERS_PER_FUNCTION = 5`, `MAX_SLICE_LINES = 40`, `SLICE_WINDOW = 5`, `MAX_CHANGE_MAP_CHARS = 6_000`; in `enclosing.ts`: `BRACE_SCAN_LINES = 3_000`.
- Split file text on `/\r?\n/`, so CRLF files behave like LF files.
- Read each snapshot source file at most once per `buildChangeMap` call, and search all caller names in that one pass.
- Tests run in Docker on Node 22: `bash scripts/test-in-docker.sh [vitest args]`. Host Node 19.3 is not a valid test run.
- Commits: conventional format, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `v2/make-reviewer-work`, never `main`. Push after each green task.

## Review Focus

1. **CRLF files** (repos checked out on Windows): spans and callers must match the LF result. Test in Task 1.
2. **Python multi-line signatures and decorators**: the span starts at the `def` line, and the body is found below the closing `):`. Test in Task 1.
3. **Names with `$`** (JS): the name is regex-escaped, nothing throws, and `$get(` callers are found. Test in Task 2.
4. **Deleted or binary files in the diff**: skipped without throwing. Test in Task 2.
5. **Recursion**: a call inside the changed function's own span is not listed as a caller. Test in Task 2.

---

### Task 1: Enclosing-function finder

**Files:**
- Create: `src/workspace/enclosing.ts`
- Modify: `src/verify/relation.ts` (export the existing `symbolsIn` as `declaredSymbols`; keep the local usage)
- Modify: `scripts/test-in-docker.sh` (pass arguments through to vitest: `-e VITEST_ARGS="$*"` on `docker run`, `npx vitest run ${VITEST_ARGS:-}` inside)
- Test: `tests/workspace/enclosing.test.ts`
- Fixture: `tests/fixtures/change-map/case001/` (created here, also used by Tasks 2-3)

**Interfaces:**
- Consumes: `declaredSymbols(line: string): string[]` from `src/verify/relation.ts`
- Produces:
  - `export interface FunctionSpan { readonly name: string; readonly startLine: number; readonly endLine: number }` (1-based, inclusive)
  - `export function enclosingFunction(path: string, lines: readonly string[], lineNo: number): FunctionSpan | undefined`
  - `export const isSupportedSource = (path: string): boolean` (true for `.py` and the brace extensions)

- [ ] **Step 1: Create the Case 001 fixture.** From `C:\Users\varun\cra-runs\case001-repo`, copy these files at `63f9aa5` with `git show 63f9aa5:<path>` into `tests/fixtures/change-map/case001/<path>`: `app/services/hold_service.py`, `app/services/booking_service.py`, `app/api/routes_holds.py`, `tests/test_hold_durability.py`. Then `git diff b70fc05 63f9aa5 > tests/fixtures/change-map/case001.diff`. Write `tests/fixtures/change-map/README.md` in the style of `tests/fixtures/eval/README.md`, with one table row: the source repo, commits `b70fc05..63f9aa5`, "copied verbatim, LF line endings".

- [ ] **Step 2: Write the failing tests** in `tests/workspace/enclosing.test.ts`. Load fixture files with `readFileSync(...).split(/\r?\n/)`.

```ts
expect(enclosingFunction("app/services/hold_service.py", hold, 97)).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
expect(enclosingFunction("app/services/hold_service.py", hold, 90)).toEqual({ name: "get_hold", startLine: 90, endLine: 102 }); // the def line itself
expect(enclosingFunction("app/services/hold_service.py", hold, 124)).toEqual({ name: "_require_active", startLine: 123, endLine: 127 });
expect(enclosingFunction("app/services/booking_service.py", booking, 29)).toEqual({ name: "confirm", startLine: 28, endLine: 51 });
expect(enclosingFunction("app/services/hold_service.py", hold, 3)).toBeUndefined();          // module level import
expect(enclosingFunction("README.md", ["def x():", "  y()"], 2)).toBeUndefined();            // unsupported extension
// CRLF: same result as LF
expect(enclosingFunction("app/services/booking_service.py", booking.join("\r\n").split(/\r?\n/), 29)).toEqual({ name: "confirm", startLine: 28, endLine: 51 });
```

Inline cases (small arrays of lines):
- Python nested `def inner()` inside `def outer()`: a line in `inner` returns `inner`; a line in `outer` after `inner` ends returns `outer`.
- Python decorator plus multi-line signature (`@app.get("/x")`, `def handler(`, `    a: int,`, `) -> dict:`, `    return a`): the body line returns `{ name: "handler", startLine: 2, endLine: 5 }`.
- TS class method (`export class A {`, `  find(id: string): User {`, `    return db.get(id);`, `  }`, `}`): line 3 returns `find`, 2-4.
- TS arrow function: `const handler = (a: number) => {` ... `};`.
- TS brace inside a string (`const s = "}";` inside a function) does not end the block early.

- [ ] **Step 3: Run the tests to verify they fail.** Run `bash scripts/test-in-docker.sh tests/workspace/enclosing.test.ts`. Expected: FAIL, cannot resolve `src/workspace/enclosing.js`.

- [ ] **Step 4: Implement `enclosingFunction` in `src/workspace/enclosing.ts`.**
  - `.py`: walk up from `lineNo`, tracking the smallest indentation seen on non-blank lines (start from the target line's indentation; a blank target line starts at infinity). The first `^\s*(?:async\s+)?(?:def|class)\s+(\w+)` line whose indentation is below that minimum, or that is the target line itself, is the answer. If a non-def line at indentation 0 is passed first, return `undefined`. The end is the last non-blank line before the first later non-blank line whose indentation is at or below the def's indentation; lines inside the signature's parentheses don't count.
  - Brace extensions (`.ts .tsx .js .jsx .mjs .cjs .java .go .rs .c .h .cc .cpp .hpp .cs .kt .swift .php .scala`): walk up at most `BRACE_SCAN_LINES` lines. For each line where `declaredSymbols(line)` is non-empty, count braces from that line forward, after removing `//` comments and single-line string literals (`/(["'`])(?:\\.|(?!\1).)*\1/g`). A `{` must open within 3 lines of the declaration. The block ends where depth returns to 0. Return the first block whose end is at or after `lineNo`.
  - Other extensions: `undefined`.

- [ ] **Step 5: Run the tests to verify they pass.** Run `bash scripts/test-in-docker.sh tests/workspace/enclosing.test.ts tests/verify/relation.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** `feat: find the function a changed line sits in (Python and brace languages)`, including the fixture, the script change, the `relation.ts` export and this plan file (`docs/superpowers/plans/2026-11-13-change-map.md`).

### Task 2: Build the change map (changed functions + callers)

**Files:**
- Create: `src/workspace/change-map.ts`
- Test: `tests/workspace/change-map.test.ts`

**Interfaces:**
- Consumes: `enclosingFunction`, `isSupportedSource`, `FunctionSpan` (Task 1); `declaredSymbols` (relation.ts); `isTestPath` from `src/risk/paths.ts`; `DiffEntry` from `src/types.ts`; `planReview` from `src/plan.ts` (tests only)
- Produces:

```ts
export interface CodeSlice { readonly startLine: number; readonly endLine: number; readonly text: string }
export interface CallSite { readonly path: string; readonly line: number; readonly caller?: FunctionSpan; readonly slice: CodeSlice }
export interface ChangedFunction {
  readonly path: string; readonly span: FunctionSpan; readonly changedLines: readonly number[];
  readonly callersSearched: boolean; readonly callers: readonly CallSite[]; readonly moreCallers: number;
}
export interface ChangeMap { readonly functions: readonly ChangedFunction[]; readonly omittedFunctions: number; readonly unreadableFiles: number }
export async function buildChangeMap(snapshotRoot: string, entries: readonly DiffEntry[], files: readonly string[]): Promise<ChangeMap>
```

- [ ] **Step 1: Write the failing tests.** Case 001 uses the fixture directory as `snapshotRoot`, `planReview(readFileSync(case001.diff))` for the entries, and the four fixture paths as `files`.

```ts
const getHold = map.functions.find((f) => f.span.name === "get_hold")!;
expect(getHold.path).toBe("app/services/hold_service.py");
expect(getHold.span).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
expect(getHold.changedLines).toEqual([91, 92, 93, 94, 95, 97, 98, 99, 100, 101, 102]);
expect(getHold.callers.map((c) => [c.path, c.line, c.caller])).toEqual([
  ["app/services/booking_service.py", 29, { name: "confirm", startLine: 28, endLine: 51 }],
  ["app/services/hold_service.py", 124, { name: "_require_active", startLine: 123, endLine: 127 }],
]);                                                   // routes_holds.py:18 is a *definition* of another get_hold: not a caller
expect(getHold.callers[0]!.slice).toMatchObject({ startLine: 28, endLine: 51 });
expect(getHold.callers[0]!.slice.text).toContain("self._holds.get_hold(hold_id)");
expect(map.functions.some((f) => f.path.startsWith("tests/"))).toBe(false); // test-file functions are not listed
```

Temp-directory cases (`mkdtempSync`, same helper style as `tests/workspace/review-context.test.ts`):
- **Removal only:** deleting one body line of a Python function attributes the change to that function (use the new-file line just before the removal).
- **Cap:** 7 callers of `compute(` across files (two under `tests/`): `callers.length === 5`, `moreCallers === 2`, non-test callers listed first, then by path and line.
- **Not searched:** `__init__` and a 2-letter name give `callersSearched === false` and `callers` `[]`.
- **Missing from snapshot:** an entry whose file is not in `snapshotRoot` (withheld) is skipped without throwing.
- **Review Focus 3:** a JS function named `$get` with a caller `$get(1)` is found.
- **Review Focus 4:** `status: "deleted"` and `isBinary: true` entries are skipped without throwing.
- **Review Focus 5:** a recursive call inside the changed function's own span is not a caller.
- **Slice window:** a caller whose function is longer than 40 lines gets the slice `[line-5, line+5]`, clipped to the function.

- [ ] **Step 2: Run the tests to verify they fail.** Run `bash scripts/test-in-docker.sh tests/workspace/change-map.test.ts`. Expected: FAIL, cannot resolve `src/workspace/change-map.js`.

- [ ] **Step 3: Implement `buildChangeMap`.**
  - Changed positions per entry: `addedLineNumbers`, plus, for each hunk in `entry.patch` that has removed lines, the new-file line just before each removed run.
  - Skip deleted, binary, test-path and unsupported entries, and files missing from the snapshot.
  - Group positions by enclosing span. Sort by path, then `startLine`. Keep `MAX_CHANGED_FUNCTIONS`; the rest is `omittedFunctions`.
  - Callers, in one pass over `files.filter(isSupportedSource)`: a line matches `(?<![\w$])<escaped name>\s*\(`. It is not a caller when it declares that name (Python: `^\s*(?:async\s+)?def\s+name\b` or `^\s*class\s+name\b`; braces: `declaredSymbols(line).includes(name)`) or when it sits inside the changed function's own span.
  - Skip caller search for names under 3 characters or matching `^__\w+__$`.
  - Slice: the caller's whole function when it has at most `MAX_SLICE_LINES` lines, otherwise `line ± SLICE_WINDOW` clipped to the function, or to the file when there's no function. A file that can't be read adds 1 to `unreadableFiles`.
  - Freeze the result.

- [ ] **Step 4: Run the tests to verify they pass.** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** `feat: build a change map of changed functions and their callers`.

### Task 3: Put the map in the review context and wire it into prepare

**Files:**
- Modify: `src/workspace/change-map.ts` (add `renderChangeMap`)
- Modify: `src/workspace/review-context.ts` (`writeReviewContext` takes an optional map; `sharedContext` inserts the text)
- Modify: `src/cli/prepare.ts` (build the map after the snapshot is copied)
- Test: `tests/workspace/change-map.test.ts`, `tests/workspace/review-context.test.ts`

**Interfaces:**
- Consumes: `ChangeMap`, `buildChangeMap` (Task 2)
- Produces:
  - `export function renderChangeMap(map: ChangeMap, maxChars: number = MAX_CHANGE_MAP_CHARS): string`
  - `writeReviewContext(ctxDir: string, plan: ReviewPlan, meta: ContextMeta, changeMap?: ChangeMap): Promise<void>`, which writes `change-map.json` when given

- [ ] **Step 1: Write the failing tests.** The exact text is fixed here:

```ts
const text = renderChangeMap(case001Map);
expect(text.startsWith("Changed functions and who calls them (found by text search before the review; a caller may be missing or unrelated):\n")).toBe(true);
expect(text).toContain("- app/services/hold_service.py:90-102 get_hold (changed lines 91-95, 97-102)\n");
expect(text).toContain("  - called at app/services/booking_service.py:29 in confirm (lines 28-51)\n");
expect(text).toContain("  - called at app/services/hold_service.py:124 in _require_active (lines 123-127)\n");
expect(text).toContain("\nCaller code:\n--- app/services/booking_service.py:28-51 (confirm) ---\n");
expect(text).toContain("   29          hold = self._holds.get_hold(hold_id)\n"); // line number padStart(5), two spaces, source line
expect(renderChangeMap({ functions: [], omittedFunctions: 0, unreadableFiles: 0 })).toBe("");
const short = renderChangeMap(case001Map, 400);
expect(short.length).toBeLessThanOrEqual(400 + 120);
expect(short).toContain("caller slices omitted for length; read them with cra_read]");
```

Other fixed lines: `  [N more callers not listed]`, `  [callers not searched: name too short or special]`, `[N more changed functions not listed]`. Index lines always come first. Slices are added in order while the total stays within `maxChars`.

In `review-context.test.ts`:
- With a map: `shared-context.txt` contains the section, and it comes before `\nDiff:\n`. `change-map.json` parses back to the map.
- Without a map: no section and no `change-map.json` (the existing tests stay green unchanged).

- [ ] **Step 2: Run the tests to verify they fail.** Run `bash scripts/test-in-docker.sh tests/workspace`. Expected: FAIL on `renderChangeMap` and the new review-context cases.

- [ ] **Step 3: Implement.**
  - `renderChangeMap` writes changed lines as ranges (`91-95, 97-102`).
  - In `sharedContext`, the rendered text goes between the header and `Diff:`. It counts against `MAX_SHARED_CONTEXT_CHARS` before the diff's room is computed, and still passes through `redactSecrets`.
  - In `prepare.ts`, after `snapshot.status` is `ready`: `const changeMap = await buildChangeMap(cmd.outRepo, planned.plan.entries, snapshot.copied.map((f) => f.path));`, then pass it to `writeReviewContext`. An exception falls into the existing catch, and the prepare step fails closed with `workspace_<code>`.

- [ ] **Step 4: Run the full suite.** Run `bash scripts/test-in-docker.sh`. Expected: `tsc: ok`, all tests pass (855 plus the new ones).

- [ ] **Step 5: Commit** `feat: give the reviewer the change map in its shared context`.

### Task 4: Verify on the real Case 001 and push

**Files:** none changed (verification only)

- [ ] **Step 1: Run prepare on the real Case 001 repo** in Node 22, from `code-review-lite` in Git Bash:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)":/src:ro -v "C:/Users/varun/cra-runs/case001-repo":/case:ro node:22-slim bash -c '
  set -e; apt-get update -qq && apt-get install -y -qq git >/dev/null; git config --global --add safe.directory "*"
  mkdir /app; cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=spike . | (cd /app && tar xf -); cd /app
  npm ci --no-audit --no-fund --loglevel=error; npx tsc -p tsconfig.build.json
  node dist/cli.js prepare --repo /case --base b70fc05 --head 63f9aa5 --out-repo /tmp/r --out-ctx /tmp/c
  sed -n "/^Changed functions/,/^Diff:/p" /tmp/c/shared-context.txt'
```

Expected: the section lists `app/services/hold_service.py:90-102 get_hold` with `called at app/services/booking_service.py:29 in confirm (lines 28-51)`, and the caller code shows lines 28-51.

- [ ] **Step 2: Check the container plumbing still works (scripted stub, no key):** `mkdir -p /c/Users/varun/cra-runs/lean-e2e && bash experiments/lean/e2e.sh /c/Users/varun/cra-runs/lean-e2e report`. Expected: `all lean checks passed`.

- [ ] **Step 3: Push** `git push origin v2/make-reviewer-work`. Expected: the remote branch moves to the Task 3 commit.
