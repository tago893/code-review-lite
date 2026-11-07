import { describe, expect, it } from "vitest";
import { parseReviewerOutput } from "../../src/findings/schema.js";
import { fake } from "../safety/fakes.js";

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: "security",
  severity: "warning",
  file: "src/users.ts",
  line: 5,
  evidence: 'db.query("SELECT * FROM users WHERE id = " + userId);',
  claim: "userId reaches the query unescaped, so a crafted id changes the SQL.",
  path: "getUser(req.params.id) -> db.query",
  ...over,
});

describe("parseReviewerOutput: accepted shapes", () => {
  it("parses a JSON array and attaches the reviewer and a generated id", () => {
    const { findings, error } = parseReviewerOutput(JSON.stringify([item(), item({ line: 9 })]), "security-1");
    expect(error).toBeUndefined();
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ file: "src/users.ts", line: 5, reviewer: "security-1", id: "security-1-1", category: "security" });
    expect(findings[1]?.id).toBe("security-1-2");
    expect(findings[0]?.level).toBeUndefined();
  });

  it("returns frozen findings", () => {
    const { findings } = parseReviewerOutput(JSON.stringify([item()]), "r");
    expect(Object.isFrozen(findings)).toBe(true);
    expect(Object.isFrozen(findings[0])).toBe(true);
  });

  it("accepts an object with a findings array, a fenced block and surrounding prose", () => {
    const body = JSON.stringify({ findings: [item()] });
    expect(parseReviewerOutput(body, "r").findings).toHaveLength(1);
    expect(parseReviewerOutput("```json\n" + JSON.stringify([item()]) + "\n```", "r").findings).toHaveLength(1);
    expect(parseReviewerOutput("Here are my findings:\n" + JSON.stringify([item()]) + "\nDone.", "r").findings).toHaveLength(1);
  });

  it("accepts an empty list without an error", () => {
    expect(parseReviewerOutput("[]", "r")).toEqual({ findings: [] });
  });

  it("is not confused by brackets and braces inside strings", () => {
    const tricky = item({ evidence: 'if (x) { arr[0] = "]"; }' });
    const { findings, error } = parseReviewerOutput("note: [see below]\n" + JSON.stringify([tricky]), "r");
    expect(error).toBeUndefined();
    expect(findings[0]?.evidence).toBe('if (x) { arr[0] = "]"; }');
  });
});

describe("parseReviewerOutput: rejected input never throws", () => {
  it("returns an error and no findings for truncated JSON", () => {
    const text = JSON.stringify([item(), item({ line: 9 })]);
    const result = parseReviewerOutput(text.slice(0, text.length - 40), "r");
    expect(result.findings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it.each([["empty", ""], ["prose only", "no findings here"], ["a string", '"x"'], ["a number", "42"], ["null", "null"]])(
    "returns an error for %s",
    (_name, text) => {
      const result = parseReviewerOutput(text, "r");
      expect(result.findings).toEqual([]);
      expect(result.error).toBeDefined();
    },
  );

  it("survives non-string input", () => {
    expect(parseReviewerOutput(undefined as unknown as string, "r").error).toBeDefined();
    expect(parseReviewerOutput({} as unknown as string, "r").error).toBeDefined();
  });

  it("rejects oversized output and too many findings", () => {
    expect(parseReviewerOutput("[" + " ".repeat(2_000_000) + "]", "r").error).toBeDefined();
    const many = Array.from({ length: 51 }, () => item());
    expect(parseReviewerOutput(JSON.stringify(many), "r").error).toBeDefined();
  });

  it.each([
    ["unknown severity", { severity: "blocker" }],
    ["unknown category", { category: "style" }],
    ["line 0", { line: 0 }],
    ["negative line", { line: -3 }],
    ["fractional line", { line: 1.5 }],
    ["line as a string", { line: "5" }],
    ["empty evidence", { evidence: "" }],
    ["missing claim", { claim: undefined }],
    ["empty file", { file: "" }],
    ["very long evidence", { evidence: "x".repeat(5000) }],
  ])("drops an item with %s and reports it", (_name, over) => {
    const result = parseReviewerOutput(JSON.stringify([item(), item(over)]), "r");
    expect(result.findings).toHaveLength(1);
    expect(result.error).toMatch(/1 of 2/);
  });

  it("never echoes input text in the error", () => {
    const secret = fake.groq();
    const result = parseReviewerOutput(JSON.stringify([item({ severity: secret })]), "r");
    expect(result.error).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    const bad = parseReviewerOutput(`[{"file": "${secret}", `, "r");
    expect(JSON.stringify(bad)).not.toContain(secret);
  });

  it("ignores unknown keys instead of passing them through", () => {
    const { findings } = parseReviewerOutput(JSON.stringify([item({ verdict: "approved", level: "independently_confirmed" })]), "r");
    expect(findings[0]).not.toHaveProperty("verdict");
    expect(findings[0]?.level).toBeUndefined();
  });
});
