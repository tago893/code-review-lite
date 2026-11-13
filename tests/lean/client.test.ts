import { describe, expect, it } from "vitest";
import { createChat, parseDuration, ProviderError, type TranscriptEntry } from "../../experiments/lean/client.js";
import type { FetchLike } from "../../src/agents/structured.js";

type Reply = { status: number; body: string; headers?: Record<string, string> };
function fake(...replies: Reply[]): { fetchFn: FetchLike; calls: () => number; bodies: () => string[] } {
  const bodies: string[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(init.body);
    const r = replies[Math.min(bodies.length - 1, replies.length - 1)] as Reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body };
  };
  return { fetchFn, calls: () => bodies.length, bodies: () => bodies };
}
const ok = { status: 200, body: JSON.stringify({ choices: [] }) };
const err = (status: number, code: string, headers?: Record<string, string>): Reply => ({ status, headers: headers ?? {}, body: JSON.stringify({ error: { message: "SECRET SOURCE TEXT", type: "tokens", code } }) });

describe("lean client", () => {
  it("retries HTTP 429, waiting for Retry-After, then succeeds", async () => {
    const f = fake(err(429, "rate_limit_exceeded", { "retry-after": "3" }), ok);
    const waits: number[] = [];
    const result = await createChat({ baseUrl: "http://p/v1", fetchFn: f.fetchFn, sleep: async (ms) => { waits.push(ms); } })({ a: 1 });
    expect(result.retries).toBe(1);
    expect(waits).toEqual([3000]);
    expect(f.bodies()[0]).toBe(f.bodies()[1]); // the retry is the identical request
  });

  it("gives up after a bounded number of 429s and keeps status and code", async () => {
    const f = fake(err(429, "rate_limit_exceeded"));
    const error = await createChat({ baseUrl: "http://p/v1", fetchFn: f.fetchFn, sleep: async () => undefined, maxRetriesPerCall: 2 })({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 429, code: "rate_limit_exceeded", retries: 2, message: "provider_429_rate_limit_exceeded" });
    expect(f.calls()).toBe(3);
  });

  it("caps the total retries across calls", async () => {
    const f = fake(err(429, "rate_limit_exceeded"));
    const chat = createChat({ baseUrl: "http://p/v1", fetchFn: f.fetchFn, sleep: async () => undefined, maxRetriesPerCall: 5, maxRetriesTotal: 2 });
    await chat({}).catch(() => undefined);
    await chat({}).catch(() => undefined);
    expect(f.calls()).toBe(4); // 1 + 2 retries, then the second call gets its single attempt
  });

  it("never retries a 400 or a 500, and never exposes the response body", async () => {
    for (const status of [400, 500]) {
      const f = fake(err(status, "invalid_request_error"));
      const error = (await createChat({ baseUrl: "http://p/v1", fetchFn: f.fetchFn, sleep: async () => undefined })({}).catch((e: unknown) => e)) as ProviderError;
      expect(f.calls()).toBe(1);
      expect(error.status).toBe(status);
      expect(JSON.stringify([error.message, error.code, error.errorType])).not.toContain("SECRET");
    }
  });

  it("reports unusable error bodies and malformed success bodies with fixed words", async () => {
    expect(await createChat({ baseUrl: "http://p", fetchFn: fake({ status: 400, body: "<html>" }).fetchFn })({}).catch((e: unknown) => e)).toMatchObject({ status: 400, code: "unknown" });
    expect(await createChat({ baseUrl: "http://p", fetchFn: fake({ status: 200, body: "<html>" }).fetchFn })({}).catch((e: unknown) => e)).toMatchObject({ status: 200, code: "malformed_response" });
  });

  it("turns a deadline abort during a wait into the deadline code", async () => {
    const controller = new AbortController();
    const f = fake(err(429, "rate_limit_exceeded", { "retry-after": "30" }));
    const pending = createChat({ baseUrl: "http://p", fetchFn: f.fetchFn, signal: controller.signal })({});
    setTimeout(() => controller.abort(), 20);
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ status: 0, code: "deadline" });
  });

  it("reports the token rate-limit headers of a reply as numbers", async () => {
    const headers = { "x-ratelimit-remaining-tokens": "5120", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-reset-tokens": "1m2.5s" };
    const result = await createChat({ baseUrl: "http://p", fetchFn: fake({ status: 200, body: "{}", headers }).fetchFn })({});
    expect(result.rate).toEqual({ remainingTokens: 5120, limitTokens: 8000, resetTokensMs: 62_500 });
    expect((await createChat({ baseUrl: "http://p", fetchFn: fake(ok).fetchFn })({})).rate).toEqual({});
  });

  it("parses Groq's duration format and rejects anything else", () => {
    expect(parseDuration("7.66s")).toBe(7_660);
    expect(parseDuration("2m59.56s")).toBe(179_560);
    expect(parseDuration("120ms")).toBe(120);
    expect(parseDuration("1h2m")).toBe(3_720_000);
    for (const bad of ["", "soon", "5", "-3s", "1s; drop"]) expect(parseDuration(bad)).toBeUndefined();
  });

  it("hands every attempt to the transcript hook, including the raw body of a failure", async () => {
    const generation = JSON.stringify({ error: { message: "m", type: "invalid_request_error", code: "tool_use_failed", failed_generation: "RAW_MODEL_OUTPUT" } });
    const f = fake(err(429, "rate_limit_exceeded"), { status: 400, body: generation });
    const entries: TranscriptEntry[] = [];
    await createChat({ baseUrl: "http://p", fetchFn: f.fetchFn, sleep: async () => undefined, onTranscript: (e) => entries.push(e) })({ q: 1 }).catch(() => undefined);
    expect(entries.map((e) => [e.attempt, e.status])).toEqual([[0, 429], [1, 400]]);
    expect(entries[0]?.request).toEqual({ q: 1 });
    expect(entries[1]?.response).toContain("RAW_MODEL_OUTPUT");
  });

  it("caps a transcript response so one huge body cannot fill the disk", async () => {
    const entries: TranscriptEntry[] = [];
    await createChat({ baseUrl: "http://p", fetchFn: fake({ status: 200, body: JSON.stringify({ x: "y".repeat(300_000) }) }).fetchFn, onTranscript: (e) => entries.push(e) })({});
    expect(entries[0]?.response.length).toBeLessThanOrEqual(100_100);
    expect(entries[0]?.response).toContain("[truncated");
  });

  it("sends only a placeholder credential", async () => {
    let seen = "";
    const fetchFn: FetchLike = async (_u, init) => { seen = JSON.stringify(init.headers); return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; };
    await createChat({ baseUrl: "http://p", fetchFn })({});
    expect(seen).toContain("proxy-placeholder");
  });
});
