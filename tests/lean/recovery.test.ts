import { beforeAll, describe, expect, it } from "vitest";
import { createChat, ProviderError } from "../../experiments/lean/client.js";
import { CORRECTIVE_MESSAGE, type TraceEvent } from "../../experiments/lean/loop.js";
import { reviewLean, type LeanOptions } from "../../experiments/lean/run.js";
import type { FetchLike } from "../../src/agents/structured.js";
import { makeFixture, PROMPTS, textTurn, toolTurn, type Fixture } from "./fixture.js";

// Recovery from Groq's tool_use_failed (HTTP 400): one corrective-feedback attempt per run, nothing else. The provider is a
// scripted fetch, so the real client, loop and review function run unchanged.

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

const SENTINEL = "SECRET_SOURCE_SENTINEL_9f3a";
const rejected = (name: string): string => JSON.stringify({ error: { message: `tool call validation failed: attempted to call tool '${name}' which was not in request.tools`, type: "invalid_request_error", code: "tool_use_failed", failed_generation: `{"name":"${name}","arguments":{"path":"${SENTINEL}"}}` } });
const GARBLED = rejected("cra_read<|channel|>commentary");
const other400 = (code: string): string => JSON.stringify({ error: { message: `x ${SENTINEL}`, type: "invalid_request_error", code } });

type Step = { status: number; body: string } | unknown;
const reply = (json: unknown): Step => ({ status: 200, body: JSON.stringify(json) });
const fail = (body: string): Step => ({ status: 400, body });

/** Answers the nth request with the nth step (the last repeats). Records every request body. */
function provider(...steps: Step[]): { fetchFn: FetchLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const step = steps[Math.min(bodies.length - 1, steps.length - 1)] as { status: number; body: string };
    return { ok: step.status < 300, status: step.status, headers: { get: () => null }, text: async () => step.body };
  };
  return { fetchFn, bodies };
}

function run(p: ReturnType<typeof provider>, over: Partial<LeanOptions> = {}): Promise<Awaited<ReturnType<typeof reviewLean>>> & { events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const chat = createChat({ baseUrl: "http://p/v1", fetchFn: p.fetchFn, sleep: async () => undefined });
  const promise = reviewLean({ repo: fx.repo, ctx: fx.ctx, prompts: PROMPTS, category: "security", model: "m", chat, maxTurns: 6, maxRequestBytes: 32_000, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: (e) => events.push(e), ...over });
  return Object.assign(promise, { events });
}
const listTurn = reply(toolTurn([["cra_list", {}]]));
const done = reply(textTurn("No findings."));
const feedbackCount = (body: Record<string, unknown>): number => (body["messages"] as { role: string; content: unknown }[]).filter((m) => m.role === "user" && m.content === CORRECTIVE_MESSAGE).length;

describe("tool_use_failed recovery", () => {
  it("recovers: the retry carries the fixed corrective message and the review completes", async () => {
    const p = provider(listTurn, fail(GARBLED), done);
    const r = run(p);
    const result = await r;
    expect(result).toMatchObject({ status: "complete", recoveryAttempted: true });
    expect(p.bodies).toHaveLength(3);
    expect(feedbackCount(p.bodies[1] as Record<string, unknown>)).toBe(0);
    expect(feedbackCount(p.bodies[2] as Record<string, unknown>)).toBe(1);
    expect(r.events.find((e) => e["event"] === "recovery")).toMatchObject({ kind: "unknown_tool", nameShape: "garbled_read" });
    expect(CORRECTIVE_MESSAGE).toMatch(/cra_read.*cra_grep.*cra_glob.*cra_list/);
  });

  it("recovers from a failure on the very first request too", async () => {
    const p = provider(fail(GARBLED), done);
    expect(await run(p)).toMatchObject({ status: "complete", recoveryAttempted: true });
    expect(feedbackCount(p.bodies[1] as Record<string, unknown>)).toBe(1);
  });

  it("keeps the corrective message in later requests of the same run", async () => {
    const p = provider(listTurn, fail(GARBLED), listTurn, done);
    expect(await run(p)).toMatchObject({ status: "complete" });
    expect(feedbackCount(p.bodies[3] as Record<string, unknown>)).toBe(1);
  });

  it("reports repeated failure as incomplete with the subtype, after exactly one recovery request", async () => {
    const p = provider(listTurn, fail(GARBLED));
    const result = await run(p);
    expect(result).toMatchObject({ status: "incomplete", reason: "provider_400_tool_use_failed", recoveryAttempted: true, diagnostic: { kind: "unknown_tool", nameShape: "garbled_read" } });
    expect(p.bodies).toHaveLength(3); // list, failure, ONE recovery request
  });

  it("allows only one recovery per run, even if a later turn fails again", async () => {
    const p = provider(listTurn, fail(GARBLED), listTurn, fail(GARBLED), done);
    const result = await run(p);
    expect(result).toMatchObject({ status: "incomplete", reason: "provider_400_tool_use_failed", recoveryAttempted: true });
    expect(p.bodies).toHaveLength(4);
  });

  it("does not retry any other HTTP 400, or a non-400 failure", async () => {
    for (const code of ["context_length_exceeded", "invalid_request_error", "unknown"]) {
      const p = provider(listTurn, fail(other400(code)));
      const result = await run(p);
      expect(result).toMatchObject({ status: "incomplete", reason: `provider_400_${code}`, recoveryAttempted: false });
      expect(p.bodies).toHaveLength(2);
    }
    const p = provider(listTurn, { status: 500, body: GARBLED });
    expect(await run(p)).toMatchObject({ reason: "provider_500_tool_use_failed", recoveryAttempted: false });
    expect(p.bodies).toHaveLength(2);
  });
});

describe("tool_use_failed recovery: existing limits still apply", () => {
  it("takes a normal turn: the step limit can end the run right after it", async () => {
    const p = provider(listTurn, fail(GARBLED), listTurn);
    expect(await run(p, { maxTurns: 3 })).toMatchObject({ status: "incomplete", reason: "step_limit", recoveryAttempted: true });
    expect(p.bodies).toHaveLength(3);
  });

  it("does not recover when the failing request was the last allowed turn", async () => {
    const p = provider(listTurn, fail(GARBLED));
    expect(await run(p, { maxTurns: 2 })).toMatchObject({ status: "incomplete", reason: "provider_400_tool_use_failed", recoveryAttempted: false });
    expect(p.bodies).toHaveLength(2);
  });

  it("counts the corrective message in the request-size budget", async () => {
    const probe = run(provider(listTurn, fail(GARBLED), done));
    await probe;
    const failing = probe.events.filter((e) => e["event"] === "request")[1]?.["bytes"] as number;
    const p = provider(listTurn, fail(GARBLED), done);
    const result = await run(p, { maxRequestBytes: failing + 20 });
    expect(result).toMatchObject({ status: "incomplete", reason: "request_budget_exceeded" });
    expect(p.bodies).toHaveLength(2); // the oversized recovery request was never sent
  });

  it("does not run a recovery after the deadline", async () => {
    const controller = new AbortController();
    const base = provider(listTurn, fail(GARBLED), done);
    const fetchFn: FetchLike = async (u, i) => { const r = await base.fetchFn(u, i); if (base.bodies.length === 2) controller.abort(); return r; };
    const result = await run({ fetchFn, bodies: base.bodies }, { signal: controller.signal });
    expect(result).toMatchObject({ status: "incomplete", reason: "deadline" });
    expect(base.bodies).toHaveLength(2);
  });

  it("applies the normal 429 policy to the recovery request", async () => {
    const p = provider(listTurn, fail(GARBLED), { status: 429, body: JSON.stringify({ error: { code: "rate_limit_exceeded", type: "tokens" } }) }, done);
    const result = await run(p);
    expect(result).toMatchObject({ status: "complete", recoveryAttempted: true });
    expect(p.bodies).toHaveLength(4); // list, failure, recovery (429), recovery again (200)
    expect(feedbackCount(p.bodies[3] as Record<string, unknown>)).toBe(1);
  });
});

describe("tool_use_failed diagnostics", () => {
  const subtype = async (message: string): Promise<unknown> => {
    const body = JSON.stringify({ error: { message, type: "invalid_request_error", code: "tool_use_failed" } });
    const error = await createChat({ baseUrl: "http://p", fetchFn: provider({ status: 400, body }).fetchFn })({}).catch((e: unknown) => e);
    return (error as ProviderError).toolUse;
  };

  it("classifies the rejection into fixed words only", async () => {
    expect(await subtype("tool call validation failed: attempted to call tool 'cra_read<|channel|>commentary' which was not in request.tools")).toEqual({ kind: "unknown_tool", nameShape: "garbled_read" });
    expect(await subtype("tool call validation failed: attempted to call tool 'cra_glob_x' which was not in request.tools")).toEqual({ kind: "unknown_tool", nameShape: "garbled_glob" });
    expect(await subtype("tool call validation failed: attempted to call tool 'bash' which was not in request.tools")).toEqual({ kind: "unknown_tool", nameShape: "other_plain_name" });
    expect(await subtype("tool call validation failed: attempted to call tool 'Ünï<x>' which was not in request.tools")).toEqual({ kind: "unknown_tool", nameShape: "garbled_other" });
    expect(await subtype("tool call validation failed: attempted to call tool 'cra_read' which was not in request.tools")).toEqual({ kind: "unknown_tool", nameShape: "valid_name" });
    expect(await subtype("tool call validation failed: parameters for tool cra_read did not match schema")).toEqual({ kind: "bad_arguments" });
    expect(await subtype("Failed to call a function. Please adjust your prompt.")).toEqual({ kind: "unspecified" });
  });

  it("puts nothing from the provider message, failed_generation or source into the trace, result or next request", async () => {
    const p = provider(listTurn, fail(GARBLED));
    const r = run(p);
    const result = await r;
    const everything = JSON.stringify([result, r.events]);
    for (const forbidden of [SENTINEL, "channel", "commentary", "request.tools", "failed_generation", "Bearer", "validation failed"]) expect(everything).not.toContain(forbidden);
    expect(JSON.stringify(p.bodies[2])).not.toContain(SENTINEL); // the recovery request does not echo the rejected output
    expect(JSON.stringify(p.bodies[2])).not.toContain("commentary");
  });
});
