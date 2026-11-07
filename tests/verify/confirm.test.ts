import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmWithVerifier, type Verifier } from "../../src/verify/confirm.js";
import type { Finding } from "../../src/types.js";
import { fake } from "../safety/fakes.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conf-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const finding: Finding = {
  id: "f1", category: "security", severity: "critical", file: "src/a.ts", line: 15, evidence: "line 15",
  claim: "the claim", path: "p", reviewer: "groq-a", level: "semantically_supported",
};

describe("confirmWithVerifier", () => {
  const opts = () => ({ repoRoot: root });

  it("confirms only when the verifier answers exactly 'agrees'", async () => {
    expect(await confirmWithVerifier(finding, async () => "agrees", opts())).toBe(true);
    expect(await confirmWithVerifier(finding, async () => "disagrees", opts())).toBe(false);
    expect(await confirmWithVerifier(finding, (async () => "AGREES") as unknown as Verifier, opts())).toBe(false);
    expect(await confirmWithVerifier(finding, (async () => undefined) as unknown as Verifier, opts())).toBe(false);
  });

  it("treats a throwing or rejecting verifier as not confirmed", async () => {
    expect(await confirmWithVerifier(finding, async () => { throw new Error("rate limited"); }, opts())).toBe(false);
    expect(await confirmWithVerifier(finding, (() => { throw new Error("sync"); }) as unknown as Verifier, opts())).toBe(false);
  });

  it("fails closed, without calling the verifier, when no snapshot is provided (model evidence is never a substitute)", async () => {
    let called = false;
    const verifier: Verifier = async () => { called = true; return "agrees"; };
    expect(await confirmWithVerifier(finding, verifier, {} as never)).toBe(false);
    expect(await confirmWithVerifier(finding, verifier, undefined as never)).toBe(false);
    expect(await confirmWithVerifier(finding, verifier, { repoRoot: "" })).toBe(false);
    expect(called).toBe(false);
  });

  it("fails closed when the snapshot excerpt cannot be retrieved or the citation does not verify", async () => {
    let called = false;
    const verifier: Verifier = async () => { called = true; return "agrees"; };
    const wrongEvidence = { ...finding, evidence: "text the model invented" };
    expect(await confirmWithVerifier(wrongEvidence, verifier, opts())).toBe(false);
    expect(await confirmWithVerifier({ ...finding, file: "src/gone.ts" }, verifier, opts())).toBe(false);
    expect(await confirmWithVerifier(finding, verifier, { repoRoot: join(root, "missing") })).toBe(false);
    expect(called).toBe(false);
  });

  it("shows the verifier the snapshot's text, not the model's quoted evidence", async () => {
    writeFileSync(join(root, "src/b.ts"), "real source line");
    let code = "";
    const f2 = { ...finding, file: "src/b.ts", line: 1, evidence: "real source" };
    await confirmWithVerifier(f2, async (_f, c) => { code = c; return "agrees"; }, opts());
    expect(code).toBe("1: real source line");
  });

  it("gives the verifier the finding without its level, and numbered real code from the snapshot", async () => {
    let seen: { f: Finding; code: string } | undefined;
    await confirmWithVerifier(finding, async (f, code) => { seen = { f, code }; return "agrees"; }, { repoRoot: root, contextLines: 2 });
    expect(seen?.f).not.toHaveProperty("level");
    expect(seen?.f.claim).toBe("the claim");
    expect(seen?.code).toBe("13: line 13\n14: line 14\n15: line 15\n16: line 16\n17: line 17");
  });

  it("does not confirm, and does not call the verifier, when the snippet cannot be read", async () => {
    let called = false;
    const result = await confirmWithVerifier({ ...finding, file: "../outside" }, async () => { called = true; return "agrees"; }, { repoRoot: root });
    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  it("redacts secrets in the snippet before the verifier sees it", async () => {
    const pw = fake.password();
    writeFileSync(join(root, "src/s.ts"), `a\nconst password = "${pw}";\nb\n`);
    let code = "";
    await confirmWithVerifier({ ...finding, file: "src/s.ts", line: 2, evidence: "const password" }, async (_f, c) => { code = c; return "agrees"; }, { repoRoot: root, contextLines: 1 });
    expect(code).not.toContain(pw);
    expect(code).toContain("[REDACTED]");
  });
});
