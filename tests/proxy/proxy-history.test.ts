import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Runs the real docker/proxy/server.mjs against a local fake provider: the required-pruning stamp and the size ceiling.
const KEY = "gsk_" + "STUBKEY_PROXYTEST0123456789abcdef";
const SERVER = fileURLToPath(new URL("../../docker/proxy/server.mjs", import.meta.url));

let proc: ChildProcess | undefined;
let upstream: http.Server | undefined;
let lines: Record<string, unknown>[] = [];
let forwarded: http.IncomingHttpHeaders[] = [];
/** Statuses the fake provider answers with, in order; 200 once the list is empty. */
let answers: number[] = [];

async function start(extraEnv: Record<string, string> = {}): Promise<number> {
  forwarded = [];
  answers = [];
  upstream = http.createServer((req, res) => {
    forwarded.push(req.headers);
    req.resume();
    req.on("end", () => {
      const status = answers.shift() ?? 200;
      res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", () => r()));
  const port = 20000 + Math.floor(Math.random() * 20000);
  lines = [];
  proc = spawn(process.execPath, [SERVER], { env: { PATH: process.env["PATH"] ?? "", GROQ_API_KEY: KEY, UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, PROXY_PORT: String(port), PROXY_MODE: "stub", ...extraEnv } });
  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) lines.push(JSON.parse(part) as Record<string, unknown>);
  });
  const end = Date.now() + 4000;
  while (!lines.some((l) => l["event"] === "listening")) {
    if (Date.now() > end) throw new Error("proxy did not start");
    await new Promise((r) => setTimeout(r, 20));
  }
  return port;
}

afterEach(async () => { proc?.kill(); await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r())); });

function post(port: number, body: unknown, stamp?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers: Record<string, string | number> = { "content-type": "application/json", "content-length": Buffer.byteLength(data) };
    if (stamp !== undefined) headers["x-cra-history"] = stamp;
    const req = http.request({ host: "127.0.0.1", port, path: "/openai/v1/chat/completions", method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const withTools = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [{}] };
const noTools = { model: "m", messages: [{ role: "user", content: "hi" }] };
const events = (name: string) => lines.filter((l) => l["event"] === name);

describe("credential proxy: required history pruning", () => {
  it("refuses a tool-enabled request without the stamp, forwards nothing and spends no budget", async () => {
    const port = await start({ PROXY_REQUIRE_HISTORY: "1", PROXY_MAX_REQUESTS: "2" });
    const refused = await post(port, withTools);
    expect(refused.status).toBe(403);
    expect((JSON.parse(refused.text) as { error: { code: string } }).error.code).toBe("history_pruning_inactive");
    expect(forwarded).toHaveLength(0);
    expect(events("history_denied")[0]).toMatchObject({ reason: "unstamped", has_tools: true });
    expect((await post(port, withTools, "8000")).status).toBe(200);
    expect((await post(port, withTools, "8000")).status).toBe(200);
    expect((await post(port, withTools, "8000")).status).toBe(403); // now it is the request budget
    expect(events("history_denied")).toHaveLength(1);
    expect(events("request")[0]).toMatchObject({ history_stamp: true });
  });

  it("rejects malformed stamps", async () => {
    const port = await start({ PROXY_REQUIRE_HISTORY: "1" });
    for (const bad of ["", "0", "abc", "-1", "12345678"]) expect((await post(port, withTools, bad)).status, bad).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("does not require the stamp on requests without tools (coordinator, verifier)", async () => {
    const port = await start({ PROXY_REQUIRE_HISTORY: "1" });
    expect((await post(port, noTools)).status).toBe(200);
  });

  it("does not forward the stamp header upstream", async () => {
    const port = await start({ PROXY_REQUIRE_HISTORY: "1" });
    await post(port, withTools, "8000");
    expect(forwarded[0]?.["x-cra-history"]).toBeUndefined();
  });

  it("enforces PROXY_MAX_REQUEST_BYTES on tool-enabled requests even when stamped", async () => {
    const port = await start({ PROXY_REQUIRE_HISTORY: "1", PROXY_MAX_REQUEST_BYTES: "1000" });
    const big = { ...withTools, messages: [{ role: "user", content: "x".repeat(2000) }] };
    expect((await post(port, big, "8000")).status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "over_ceiling", ceiling: 1000 });
    expect((await post(port, { ...big, tools: undefined }, "8000")).status).toBe(200);
    expect((await post(port, withTools, "8000")).status).toBe(200);
  });

  it("changes nothing when neither option is set", async () => {
    const port = await start();
    expect((await post(port, withTools)).status).toBe(200);
    expect(lines.find((l) => l["event"] === "listening")).toMatchObject({ require_history: false, max_request_bytes: null });
  });

  it("refuses to start with an invalid ceiling", async () => {
    for (const bad of ["0", "999", "abc", "-1", "1.5"]) {
      const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env["PATH"] ?? "", GROQ_API_KEY: KEY, UPSTREAM_URL: "http://127.0.0.1:1", PROXY_MODE: "stub", PROXY_MAX_REQUEST_BYTES: bad } });
      expect(await new Promise<number | null>((resolve) => child.on("exit", resolve)), bad).toBe(1);
    }
  });
});

describe("credential proxy: authorised provider retries under required pruning", () => {
  const tools = (text: string) => ({ ...withTools, messages: [{ role: "user", content: text }] });
  const base = { PROXY_REQUIRE_HISTORY: "1" };

  it("forwards an identical unstamped retry after the stamped request got a 429", async () => {
    const port = await start({ ...base, PROXY_MAX_REQUESTS: "10" });
    answers = [429, 200];
    expect((await post(port, tools("same"), "8000")).status).toBe(429);
    expect((await post(port, tools("same"))).status).toBe(200);
    expect(forwarded).toHaveLength(2);
    expect(events("history_retry_window")[0]).toMatchObject({ retriesUsed: 0, allowance: 5 });
    expect(events("history_retry_authorized")[0]).toMatchObject({ retryNo: 1 });
    expect(JSON.stringify(lines)).not.toContain("same");
  });

  it("refuses a same-size but modified retry", async () => {
    const port = await start(base);
    answers = [429];
    await post(port, tools("aaaa"), "8000");
    const modified = await post(port, tools("aaab"));
    expect(modified.status).toBe(403);
    expect((JSON.parse(modified.text) as { error: { code: string } }).error.code).toBe("history_pruning_inactive");
    expect(forwarded).toHaveLength(1);
  });

  it("refuses a retry for a different model or path even with the same messages", async () => {
    const port = await start(base);
    answers = [429];
    await post(port, tools("x"), "8000");
    expect((await post(port, { ...tools("x"), model: "other/model" })).status).toBe(403);
    expect(forwarded).toHaveLength(1);
  });

  it("refuses an unstamped first request", async () => {
    const port = await start(base);
    expect((await post(port, tools("first"))).status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "unstamped" });
    expect(forwarded).toHaveLength(0);
  });

  it("refuses an unstamped repeat after a successful 200", async () => {
    const port = await start(base);
    expect((await post(port, tools("ok"), "8000")).status).toBe(200);
    expect((await post(port, tools("ok"))).status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "unstamped" });
    expect(forwarded).toHaveLength(1);
  });

  it("allows one retry per 429: a second unstamped copy while the first retry is in flight or answered 200 is refused", async () => {
    const port = await start(base);
    answers = [429, 200];
    await post(port, tools("once"), "8000");
    expect((await post(port, tools("once"))).status).toBe(200);
    expect((await post(port, tools("once"))).status).toBe(403);
    expect(forwarded).toHaveLength(2);
  });

  it("allows repeated retries only up to PROXY_RETRY_ALLOWANCE", async () => {
    const port = await start({ ...base, PROXY_RETRY_ALLOWANCE: "2", PROXY_MAX_REQUESTS: "20" });
    answers = [429, 429, 429, 429];
    expect((await post(port, tools("many"), "8000")).status).toBe(429);
    expect((await post(port, tools("many"))).status).toBe(429); // retry 1
    expect((await post(port, tools("many"))).status).toBe(429); // retry 2
    const third = await post(port, tools("many"));
    expect(third.status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "retry_exhausted" });
    expect(forwarded).toHaveLength(3);
  });

  it("refuses an expired retry", async () => {
    const port = await start({ ...base, PROXY_RETRY_WINDOW_MS: "300" });
    answers = [429];
    await post(port, tools("late"), "8000");
    await new Promise((r) => setTimeout(r, 450));
    expect((await post(port, tools("late"))).status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "retry_expired" });
    expect(forwarded).toHaveLength(1);
  });

  it("an allowance of 0 disables retries entirely", async () => {
    const port = await start({ ...base, PROXY_RETRY_ALLOWANCE: "0" });
    answers = [429];
    await post(port, tools("none"), "8000");
    expect((await post(port, tools("none"))).status).toBe(403);
    expect(events("history_denied")[0]).toMatchObject({ reason: "retry_exhausted" });
  });

  it("an accepted retry still spends the request budget", async () => {
    const port = await start({ ...base, PROXY_MAX_REQUESTS: "2" });
    answers = [429, 429];
    await post(port, tools("b"), "8000");
    expect((await post(port, tools("b"))).status).toBe(429);
    const third = await post(port, tools("b"));
    expect(third.status).toBe(403);
    expect((JSON.parse(third.text) as { error: { code: string } }).error.code).toBe("request_budget_exhausted");
    expect(forwarded).toHaveLength(2);
  });

  it("an accepted retry still passes the size ceiling", async () => {
    const port = await start({ ...base, PROXY_MAX_REQUEST_BYTES: "1000" });
    answers = [429];
    const big = tools("y".repeat(2000));
    expect((await post(port, big, "8000")).status).toBe(403); // over the ceiling: never forwarded, never remembered
    expect((await post(port, big)).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    // and a retry of a remembered, in-ceiling request is fine
    expect((await post(port, tools("small"), "8000")).status).toBe(429);
    expect((await post(port, tools("small"))).status).toBe(200);
  });

  it("does not let a retry authorisation help a request without tools or when pruning is not required", async () => {
    const port = await start(base);
    answers = [429];
    await post(port, tools("t"), "8000");
    expect((await post(port, { model: "m", messages: [{ role: "user", content: "t" }] })).status).toBe(200); // no tools: never gated
    expect(forwarded).toHaveLength(2);
  });

  it("refuses to start with an invalid allowance or window", async () => {
    for (const env of [{ PROXY_RETRY_ALLOWANCE: "21" }, { PROXY_RETRY_ALLOWANCE: "x" }, { PROXY_RETRY_WINDOW_MS: "100" }, { PROXY_RETRY_WINDOW_MS: "700000" }]) {
      const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env["PATH"] ?? "", GROQ_API_KEY: KEY, UPSTREAM_URL: "http://127.0.0.1:1", PROXY_MODE: "stub", ...env } });
      expect(await new Promise<number | null>((resolve) => child.on("exit", resolve)), JSON.stringify(env)).toBe(1);
    }
  });
});
