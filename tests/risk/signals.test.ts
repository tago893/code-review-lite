import { describe, expect, it } from "vitest";
import { detectSignals } from "../../src/risk/signals.js";
import { entry, excluded } from "./helpers.js";

const names = (entries: Parameters<typeof detectSignals>[0], removed?: Parameters<typeof detectSignals>[1]) =>
  detectSignals(entries, removed).map((s) => s.signal);

describe("dangerous sinks (added lines)", () => {
  it("flags SQL built by string concatenation, with file, line, family and a reason", () => {
    const e = entry({
      newPath: "src/users.ts",
      addedLines: ["const id = req.params.id;", 'db.query("SELECT * FROM users WHERE id = " + userId);'],
      addedLineNumbers: [10, 11],
    });
    const [signal] = detectSignals([e]);
    expect(signal).toMatchObject({
      signal: "sql_string_building",
      family: "dangerous_sink",
      file: "src/users.ts",
      line: 11,
    });
    expect(signal!.reason).toMatch(/SQL/);
    expect(signal!.evidence).toContain("SELECT * FROM users");
  });

  it("flags SQL interpolation in template strings and f-strings", () => {
    expect(names([entry({ newPath: "a.ts", addedLines: ["q(`SELECT * FROM t WHERE id = ${id}`);"] })])).toContain("sql_string_building");
    expect(names([entry({ newPath: "a.py", addedLines: ['cur.execute(f"DELETE FROM t WHERE id = {id}")'] })])).toContain("sql_string_building");
  });

  it("does not flag parameterised SQL", () => {
    const e = entry({ newPath: "a.ts", addedLines: ['db.query("SELECT * FROM users WHERE id = $1", [id]);'] });
    expect(detectSignals([e])).toEqual([]);
  });

  it.each([
    ["shell_exec", 'child_process.exec("ls " + dir);'],
    ["shell_exec", 'subprocess.run(cmd, shell=True)'],
    ["dynamic_code_eval", "const r = eval(input);"],
    ["unsafe_deserialization", "data = pickle.loads(blob)"],
    ["html_injection", "el.innerHTML = html;"],
    ["path_from_user_input", "const p = path.join(root, req.query.file);"],
    ["outbound_http_variable_url", "const r = await fetch(url);"],
    ["file_write", 'fs.writeFileSync(target, body);'],
  ])("flags %s", (signal, line) => {
    expect(names([entry({ newPath: "src/x.ts", addedLines: [line] })])).toContain(signal);
  });

  it.each([
    "const m = re.exec(text);",
    'fetch("https://example.com/api");',
    'const p = path.join(__dirname, "static");',
    "const r = JSON.parse(text);",
  ])("does not flag the safe look-alike %s", (line) => {
    expect(detectSignals([entry({ newPath: "src/x.ts", addedLines: [line] })])).toEqual([]);
  });

  it("ignores documentation files even when they show dangerous code", () => {
    const readme = entry({ newPath: "README.md", addedLines: ['db.query("SELECT * FROM t WHERE a = " + b);'] });
    expect(detectSignals([readme])).toEqual([]);
  });
});

describe("trust boundaries (paths)", () => {
  it("flags files under auth/ and other trust-boundary names", () => {
    for (const path of ["src/auth/login.ts", "lib/crypto/hash.py", "api/middleware/cors.ts", "svc/SessionStore.java", "x/access-token.ts"]) {
      expect(names([entry({ newPath: path })])).toContain("trust_boundary_path");
    }
  });

  it("does not match look-alike words, or documentation", () => {
    for (const path of ["src/authors.ts", "src/tokenizer.ts", "docs/auth.md", "src/oauthority.ts"]) {
      expect(names([entry({ newPath: path })])).not.toContain("trust_boundary_path");
    }
  });

  it("flags a file renamed out of a sensitive directory", () => {
    const moved = entry({ oldPath: "src/auth/check.ts", newPath: "src/lib/check.ts", status: "renamed", isRename: true });
    expect(names([moved])).toContain("trust_boundary_path");
  });
});

describe("weakened safeguards", () => {
  it("flags removal of an authorisation check", () => {
    const e = entry({ newPath: "src/api.ts", addedLines: [], removedLines: ["  if (!user.isAdmin) return;"] });
    expect(detectSignals([e])[0]).toMatchObject({ signal: "auth_check_removed", family: "weakened_safeguard" });
  });

  it("does not flag a check that was edited in place", () => {
    const e = entry({
      newPath: "src/api.ts",
      removedLines: ["  if (!user.isAdmin) return;"],
      addedLines: ["  if (!user.isAdmin && !user.isOwner) return;"],
    });
    expect(names([e])).not.toContain("auth_check_removed");
  });

  it("flags net removal of validation, error handling, and timeouts or retries", () => {
    expect(names([entry({ newPath: "a.ts", addedLines: [], removedLines: ["validateInput(body);"] })])).toContain("validation_removed");
    expect(names([entry({ newPath: "a.ts", addedLines: [], removedLines: ["} catch (e) {"] })])).toContain("error_handling_removed");
    expect(names([entry({ newPath: "a.ts", addedLines: [], removedLines: ["retries: 3,"] })])).toContain("resilience_removed");
  });

  it("flags a deleted test file, added skips, and net removal of assertions", () => {
    expect(names([entry({ newPath: "tests/users.test.ts", status: "deleted", addedLines: [], removedLines: ["x"] })])).toContain("test_deleted");
    expect(names([entry({ newPath: "tests/users.test.ts", addedLines: ['it.skip("works", () => {});'] })])).toContain("test_skipped");
    expect(names([entry({ newPath: "tests/a_test.py", addedLines: ["@pytest.mark.skip"] })])).toContain("test_skipped");
    expect(names([entry({ newPath: "tests/a.test.ts", addedLines: [], removedLines: ["expect(a).toBe(1);"] })])).toContain("assertions_removed");
  });

  it("does not flag an ordinary .skip( outside tests", () => {
    expect(detectSignals([entry({ newPath: "src/iter.rs", addedLines: ["let it = xs.iter().skip(2);"] })])).toEqual([]);
  });

  it("flags CI, lint and security configuration changes", () => {
    for (const path of [".github/workflows/ci.yml", ".eslintrc.json", ".gitlab-ci.yml", ".snyk", "Jenkinsfile"]) {
      expect(names([entry({ newPath: path })])).toContain("ci_security_config_changed");
    }
  });
});

describe("concurrency and state", () => {
  it.each([
    ["lock_or_sync_changed", "mu.Lock()"],
    ["lock_or_sync_changed", "synchronized (this) {"],
    ["transaction_changed", "await db.transaction(async (tx) => {"],
    ["transaction_changed", "COMMIT;"],
    ["cache_changed", "cache.delete(key);"],
    ["cache_changed", "@CacheEvict(value = \"users\")"],
    ["shared_mutable_state", "let counter = 0;"],
  ])("flags %s", (signal, line) => {
    expect(names([entry({ newPath: "src/svc.ts", addedLines: [line] })])).toContain(signal);
  });

  it("flags a removed lock as well as an added one", () => {
    expect(names([entry({ newPath: "a.go", addedLines: [], removedLines: ["mu.Lock()"] })])).toContain("lock_or_sync_changed");
  });

  it("flags a change in the number of awaits, not a balanced replacement", () => {
    const added = entry({ newPath: "a.ts", addedLines: ["await save(x);"], removedLines: [] });
    const dropped = entry({ newPath: "a.ts", addedLines: ["save(x);"], removedLines: ["await save(x);"] });
    const balanced = entry({ newPath: "a.ts", addedLines: ["await save(y);"], removedLines: ["await save(x);"] });
    expect(names([added])).toContain("async_flow_changed");
    expect(names([dropped])).toContain("async_flow_changed");
    expect(names([balanced])).not.toContain("async_flow_changed");
  });
});

describe("contract changes", () => {
  it("flags database migrations and schema files", () => {
    for (const path of ["db/migrations/001_add_users.sql", "alembic/versions/ab12_add.py", "prisma/schema.prisma", "schema.sql"]) {
      expect(names([entry({ newPath: path })])).toContain("db_migration");
    }
  });

  it("flags dependency manifest changes", () => {
    for (const path of ["requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "pyproject.toml"]) {
      expect(names([entry({ newPath: path })])).toContain("dependency_manifest");
    }
  });

  it("flags package.json only when a dependency-looking line changes", () => {
    const dep = entry({ newPath: "package.json", addedLines: ['    "lodash": "^4.17.21",'] });
    const version = entry({ newPath: "package.json", addedLines: ['  "version": "1.2.3",'] });
    expect(names([dep])).toContain("dependency_manifest");
    expect(names([version])).not.toContain("dependency_manifest");
  });

  it("flags a changed signature of a public function", () => {
    const e = entry({
      newPath: "src/api.ts",
      removedLines: ["export function getUser(id: string): User {"],
      addedLines: ["export function getUser(id: string, tenant: string): User {"],
    });
    expect(detectSignals([e])[0]).toMatchObject({ signal: "public_signature_changed", family: "contract_change" });
  });

  it("flags a removed public function but not an unchanged signature or a private function", () => {
    expect(names([entry({ newPath: "a.ts", addedLines: [], removedLines: ["export function gone(a: number) {"] })])).toContain("public_signature_changed");
    const same = entry({
      newPath: "a.ts",
      removedLines: ["export function f(a: number) { return 1; }"],
      addedLines: ["export function f(a: number) { return 2; }"],
    });
    expect(names([same])).not.toContain("public_signature_changed");
    const priv = entry({ newPath: "a.py", removedLines: ["def _helper(a):"], addedLines: ["def _helper(a, b):"] });
    expect(names([priv])).not.toContain("public_signature_changed");
  });

  it("flags API schema files", () => {
    for (const path of ["api/openapi.yaml", "proto/user.proto", "schema.graphql"]) {
      expect(names([entry({ newPath: path })])).toContain("api_schema_file");
    }
  });
});

describe("performance-shaped changes", () => {
  it("flags a new loop around a query or request", () => {
    const e = entry({
      newPath: "src/report.ts",
      addedLines: ["for (const id of ids) {", "  const row = await db.query(sqlFor(id));", "}"],
    });
    expect(names([e])).toContain("io_in_loop");
  });

  it("does not flag a loop with no I/O", () => {
    const e = entry({ newPath: "src/sum.ts", addedLines: ["for (const n of xs) {", "  total += n;", "}"] });
    expect(names([e])).not.toContain("io_in_loop");
  });

  it("flags a removed index or removed caching", () => {
    expect(names([entry({ newPath: "a.sql", addedLines: [], removedLines: ["CREATE INDEX idx_users_email ON users(email);"] })])).toContain("index_or_cache_removed");
    expect(names([entry({ newPath: "a.py", addedLines: [], removedLines: ["@lru_cache(maxsize=128)"] })])).toContain("index_or_cache_removed");
  });
});

describe("combination, excluded files and determinism", () => {
  it("reports several families for one change", () => {
    const e = entry({
      newPath: "src/auth/session.ts",
      addedLines: ['db.query("SELECT * FROM s WHERE id = " + id);', "let active = 0;"],
      addedLineNumbers: [4, 5],
    });
    const families = new Set(detectSignals([e]).map((s) => s.family));
    expect(families).toEqual(new Set(["trust_boundary", "dangerous_sink", "concurrency_state"]));
  });

  it("gives every signal a file and a non-empty reason", () => {
    const e = entry({ newPath: "src/auth/x.ts", addedLines: ["eval(x)"] });
    for (const s of detectSignals([e])) {
      expect(s.file).toBe("src/auth/x.ts");
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });

  it("treats an excluded lockfile as a dependency change", () => {
    const signals = detectSignals([], [excluded({ path: "packages/web/yarn.lock", kind: "lockfile" })]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ signal: "dependency_manifest", file: "packages/web/yarn.lock" });
  });

  it("still applies path rules to excluded files, so exclusion cannot hide a sensitive path", () => {
    const hidden = excluded({ path: "src/auth/keys.min.js", kind: "bundled_asset" });
    const moved = excluded({ path: "src/lib/a.ts", oldPath: "src/auth/a.ts", status: "renamed", kind: "rename_only" });
    expect(names([], [hidden])).toContain("trust_boundary_path");
    expect(names([], [moved])).toContain("trust_boundary_path");
  });

  it("does not invent signals for an excluded binary or generated asset elsewhere", () => {
    expect(detectSignals([], [excluded({ path: "assets/logo.png", kind: "binary" })])).toEqual([]);
  });

  it("is deterministic and returns frozen results without touching the input", () => {
    const input = Object.freeze([entry({ newPath: "src/auth/a.ts", addedLines: ["eval(x)"] })]);
    const first = detectSignals(input);
    expect(detectSignals(input)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
  });
});
