import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import { sanitizeEntries } from "../../src/safety/diff.js";
import { fake } from "./fakes.js";

const diffFor = (path: string, added: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((l) => `+${l}`),
    "",
  ].join("\n");

describe("sanitizeEntries", () => {
  it("redacts secrets in patch and added lines and keeps paths and line numbers", () => {
    const pw = fake.password();
    const [entry] = parseUnifiedDiff(diffFor("src/db.ts", ["const a = 1;", `const password = "${pw}";`, "const b = 2;"]));
    const result = sanitizeEntries(entry ? [entry] : []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [clean] = result.entries;
    expect(clean?.newPath).toBe("src/db.ts");
    expect(clean?.addedLineNumbers).toEqual(entry?.addedLineNumbers);
    expect(clean?.addedLines[1]).toBe('const password = "[REDACTED]";');
    expect(clean?.patch).not.toContain(pw);
    expect(JSON.stringify(result)).not.toContain(pw);
    expect(result.findings).toEqual([{ path: "src/db.ts", kind: "secret_assignment", line: 8 }]);
  });

  it("redacts a multi-line private key inside a diff and keeps the +/- markers valid", () => {
    const body = fake.privateKeyBody();
    const added = ["x", fake.pemHeader(), ...body, fake.pemFooter(), "y"];
    const [entry] = parseUnifiedDiff(diffFor("deploy/key.pem", added));
    const result = sanitizeEntries(entry ? [entry] : []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [clean] = result.entries;
    for (const piece of body) expect(clean?.patch).not.toContain(piece);
    expect(clean?.addedLines).toHaveLength(added.length);
    expect(clean?.addedLines.slice(2, 5)).toEqual(["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
  });

  it("fails closed when a redacted patch no longer parses to the same file", () => {
    const [entry] = parseUnifiedDiff(diffFor("a.ts", ["x"]));
    const pw = fake.password();
    const broken = { ...entry!, patch: `not a diff\npassword = "${pw}"\n` };
    const result = sanitizeEntries([broken]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.path).toBe("a.ts");
    expect(["reparse_mismatch", "internal_error"]).toContain(result.reason);
    expect(JSON.stringify(result)).not.toContain(pw);
  });

  it("does not mutate the input entries and returns frozen output", () => {
    const [entry] = parseUnifiedDiff(diffFor("a.ts", [`token = "${fake.github()}"`]));
    const before = entry?.patch;
    const result = sanitizeEntries(entry ? [entry] : []);
    expect(entry?.patch).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
