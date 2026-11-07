import { describe, expect, it } from "vitest";
import { createStructuredCall, type FetchLike } from "../../src/agents/structured.js";
import { VERIFIER_SCHEMA, createVerifier } from "../../src/agents/verifier.js";
import type { StructuredCall } from "../../src/agents/structured.js";
import type { Finding } from "../../src/types.js";

const f: Finding = { id: "f", category: "security", severity: "critical", file: "src/a.ts", line: 2, evidence: "e", claim: "c", path: "p", reviewer: "security" };
const answering = (content: string): { call: StructuredCall; seen: string[] } => {
  const seen: string[] = [];
  return { seen, call: async (r) => { seen.push(r.user); return { content, tokensIn: 1, tokensOut: 1 }; } };
};

describe("createVerifier", () => {
  it("agrees only on exactly {answer: agrees}", async () => {
    expect(await createVerifier(answering('{"answer":"agrees"}').call, "m")(f, "1: code")).toBe("agrees");
    for (const other of ['{"answer":"AGREES"}', '{"answer":"disagrees"}', "garbage", "{}", '{"answer":1}']) {
      expect(await createVerifier(answering(other).call, "m")(f, "1: code")).toBe("disagrees");
    }
  });

  it("sends the finding and the excerpt to the model", async () => {
    const { call, seen } = answering('{"answer":"agrees"}');
    await createVerifier(call, "m")(f, "1: code");
    expect(seen[0]).toContain("Claim: c");
    expect(seen[0]).toContain("1: code");
  });
});

describe("createStructuredCall schema parameter", () => {
  it("sends the supplied schema and name instead of the findings schema", async () => {
    let body = "";
    const fetchFn: FetchLike = async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: "{}" } }] }) };
    };
    await createStructuredCall("http://proxy/v1", fetchFn, VERIFIER_SCHEMA, "verdict")({ model: "m", system: "s", user: "u" });
    const sent = JSON.parse(body) as { response_format: { json_schema: { name: string; strict: boolean; schema: unknown } } };
    expect(sent.response_format.json_schema).toMatchObject({ name: "verdict", strict: true });
    expect(sent.response_format.json_schema.schema).toEqual(VERIFIER_SCHEMA);
    expect(body).not.toContain("tools");
  });
});
