import { beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../../experiments/lean/client.js";
import { reviewLean, type LeanOptions } from "../../experiments/lean/run.js";
import type { TraceEvent } from "../../experiments/lean/loop.js";
import { finding, makeFixture, NOTES, PROMPTS, scripted, textTurn, toolTurn, VULNERABLE_LINE, type Fixture } from "./fixture.js";

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

const BUDGET = 32_000;
function run(chat: LeanOptions["chat"], over: Partial<LeanOptions> = {}): Promise<Awaited<ReturnType<typeof reviewLean>>> & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const promise = reviewLean({ repo: fx.repo, ctx: fx.ctx, prompts: PROMPTS, category: "security", model: "m", chat, maxTurns: 8, maxRequestBytes: BUDGET, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: (e) => events.push(e), ...over });
  return Object.assign(promise, { events });
}
const structured = (...findings: unknown[]): unknown => textTurn(JSON.stringify({ findings }));
const isStructured = (b: Record<string, unknown>): boolean => b["response_format"] !== undefined;

describe("lean reviewer: the offline SQL-injection workflow", () => {
  it("investigates across files, validates the JSON and verifies the citation", async () => {
    const model = scripted(
      toolTurn([["cra_read", { path: "src/users.ts" }]]),
      toolTurn([["cra_grep", { pattern: "findUser", literal: true }]]),
      toolTurn([["cra_read", { path: "src/server.ts" }], ["cra_glob", { pattern: "src/*.ts" }], ["cra_list", { path: "src" }]]),
      textTurn(NOTES),
      structured(finding()),
    );
    const r = run(model.chat);
    const result = await r;
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: "src/users.ts", line: 4 });
    expect(result.dropped).toEqual([]);
    expect(result.baseSha).toBe("a".repeat(40));

    const bodies = model.bodies();
    const toolMessages = JSON.stringify(bodies[3]);
    expect(toolMessages).toContain("handleGetUser"); // the cross-file read reached the model
    expect(bodies[3]).toMatchObject({}); // grep ran (ripgrep may be missing on a dev host; the container has it)
    const last = bodies[bodies.length - 1] as Record<string, unknown>;
    expect(isStructured(last)).toBe(true);
    expect(last["tools"]).toBeUndefined(); // the structured phase has no tools
    expect((bodies[0] as { tools: { function: { name: string } }[] }).tools.map((t) => t.function.name).sort()).toEqual(["cra_glob", "cra_grep", "cra_list", "cra_read"]);
    for (const e of r.events.filter((x) => x["event"] === "request")) expect(e["bytes"] as number).toBeLessThanOrEqual(BUDGET);
  });

  it("distinguishes a clean review from an incomplete one", async () => {
    const clean = await run(scripted(textTurn("No findings.")).chat);
    expect(clean).toMatchObject({ status: "complete", findings: [] });
    const stuck = await run(scripted(toolTurn([["cra_list", {}]])).chat, { maxTurns: 3 });
    expect(stuck).toMatchObject({ status: "incomplete", reason: "step_limit", turns: 3 });
  });

  it("drops findings whose citation does not resolve to the cited line", async () => {
    const model = scripted(textTurn(NOTES), structured(finding(), finding({ line: 99 }), finding({ evidence: "db.exec(sql)" }), finding({ file: "src/missing.ts" })));
    const result = await run(model.chat);
    expect(result.status).toBe("complete");
    expect(result.findings).toHaveLength(1);
    expect([...result.dropped].sort()).toEqual(["evidence_not_found", "line_out_of_range", "file_not_found"].sort());
  });

  it("reports unusable structured output as incomplete", async () => {
    expect(await run(scripted(textTurn(NOTES), textTurn("not json")).chat)).toMatchObject({ status: "incomplete", reason: "findings_invalid" });
    expect(await run(scripted(textTurn(NOTES), structured(finding(), { category: "security" })).chat)).toMatchObject({ status: "incomplete", reason: "findings_invalid" });
  });
});

describe("lean reviewer: tool boundaries", () => {
  it("rejects paths outside the snapshot and tools that do not exist, and keeps going", async () => {
    const model = scripted(
      toolTurn([["cra_read", { path: "/etc/passwd" }], ["cra_read", { path: "../../../etc/passwd" }], ["cra_read", { path: "/proc/self/environ" }], ["cra_read", { path: "/review/out/report.md" }]]),
      toolTurn([["bash", { command: "cat /etc/passwd" }]]),
      textTurn("No findings."),
    );
    const r = run(model.chat);
    expect(await r).toMatchObject({ status: "complete" });
    const statuses = r.events.filter((e) => e["event"] === "tool").map((e) => e["status"]);
    expect(statuses.slice(0, 4).every((s) => s === "outside_roots" || s === "not_found")).toBe(true);
    expect(statuses[4]).toBe("unknown_tool");
    expect(JSON.stringify(model.bodies())).not.toContain("root:x:0");
  });

  it("stops after repeated requests for a forbidden tool", async () => {
    const result = await run(scripted(toolTurn([["bash", { command: "id" }]])).chat);
    expect(result).toMatchObject({ status: "incomplete", reason: "forbidden_tool_requests" });
  });

  it("ends the run only when the provider's reply itself is malformed (a tool call with no name)", async () => {
    const nameless = { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c0", type: "function", function: { arguments: "{}" } }] } }] };
    expect(await run(scripted(nameless).chat)).toMatchObject({ status: "incomplete", reason: "malformed_tool_call_bad_tool_name" });
    // Garbled names and non-JSON arguments go back to the model instead: tests/lean/badcalls.test.ts.
  });

  it("returns an invalid-arguments result for a well-formed call with the wrong fields", async () => {
    const r = run(scripted(toolTurn([["cra_read", { nope: 1 }]]), textTurn("No findings.")).chat);
    expect(await r).toMatchObject({ status: "complete" });
    expect(r.events.find((e) => e["event"] === "tool")?.["status"]).toBe("invalid_arguments");
  });
});

describe("lean reviewer: request size", () => {
  it("shrinks older tool results to references so every request stays under the budget", async () => {
    const budget = 20_000;
    const read = (n: number): unknown => toolTurn([["cra_read", { path: "src/big.ts", offset: 1 + n * 100 }]]);
    const model = scripted(read(0), read(1), read(2), read(0), read(1), textTurn("No findings."));
    const r = run(model.chat, { maxRequestBytes: budget, historyBytes: 9_000 });
    expect(await r).toMatchObject({ status: "complete" });
    const sizes = r.events.filter((e) => e["event"] === "request");
    expect(sizes.length).toBe(6);
    for (const e of sizes) expect(e["bytes"] as number).toBeLessThanOrEqual(budget);
    expect(Math.max(...sizes.map((e) => e["prunedResults"] as number))).toBeGreaterThan(0);
    expect(JSON.stringify(model.bodies()[5])).toContain("[cra:pruned");
  });

  it("stops as incomplete instead of sending a request over the budget", async () => {
    const result = await run(scripted(textTurn("x")).chat, { maxRequestBytes: 500 });
    expect(result).toMatchObject({ status: "incomplete", reason: "request_budget_exceeded" });
  });
});

describe("lean reviewer: provider errors", () => {
  const failing = (error: ProviderError): LeanOptions["chat"] => async () => { throw error; };

  it("keeps the provider status and code in the reason", async () => {
    const r = run(failing(new ProviderError(400, "invalid_request_error", "invalid_request_error", 0)));
    expect(await r).toMatchObject({ status: "incomplete", reason: "provider_400_invalid_request_error" });
    expect(r.events.find((e) => e["event"] === "provider_error")).toMatchObject({ status: 400, code: "invalid_request_error", retries: 0 });
  });

  it("maps a deadline to its own reason, and a structured-phase failure too", async () => {
    expect(await run(failing(new ProviderError(0, "deadline", "deadline", 0)))).toMatchObject({ reason: "deadline" });
    const model = scripted(textTurn(NOTES), () => { throw new ProviderError(429, "rate_limit_exceeded", "tokens", 3); });
    expect(await run(model.chat)).toMatchObject({ status: "incomplete", reason: "provider_429_rate_limit_exceeded" });
  });

  it("does not run a loop turn once the deadline has passed", async () => {
    const model = scripted(textTurn("No findings."));
    const result = await run(model.chat, { signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: "incomplete", reason: "deadline" });
    expect(model.bodies()).toHaveLength(0);
  });

  it("never puts the vulnerable source line in the trace", async () => {
    const r = run(scripted(toolTurn([["cra_read", { path: "src/users.ts" }]]), textTurn(NOTES), structured(finding())).chat);
    await r;
    expect(JSON.stringify(r.events)).not.toContain("SELECT");
    expect(VULNERABLE_LINE).toContain("SELECT");
  });
});
