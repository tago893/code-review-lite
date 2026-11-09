import { describe, expect, it } from "vitest";
import { createChat, ProviderError } from "../../experiments/lean/client.js";
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

  it("sends only a placeholder credential", async () => {
    let seen = "";
    const fetchFn: FetchLike = async (_u, init) => { seen = JSON.stringify(init.headers); return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; };
    await createChat({ baseUrl: "http://p", fetchFn })({});
    expect(seen).toContain("proxy-placeholder");
  });
});
