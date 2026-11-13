import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatFn, ChatResult } from "../../experiments/lean/client.js";
import type { TraceEvent } from "../../experiments/lean/loop.js";
import { reviewLean, transcriptSink, TRANSCRIPT_FILE } from "../../experiments/lean/run.js";
import { makeFixture, PROMPTS, textTurn, toolTurn, type Fixture } from "./fixture.js";

// What a live run records, so its throughput can be measured: per request, how many prompt tokens Groq served from its
// cache (they do not count toward the per-minute limit) and what the rate-limit headers said. Plus an opt-in private
// transcript of every exchange, for debugging a failure such as tool_use_failed.

let fx: Fixture;
beforeAll(async () => { fx = await makeFixture(); });

const withUsage = (json: unknown, cached: number): unknown => ({ ...(json as object), usage: { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: cached } } });

function chatOf(...replies: ChatResult[]): ChatFn {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)] as ChatResult;
}

describe("trace: cache and rate-limit numbers per request", () => {
  it("records cached prompt tokens and the rate-limit headers on each response, and totals the cached tokens", async () => {
    const chat = chatOf(
      { json: withUsage(toolTurn([["cra_list", {}]]), 0), retries: 0, rate: { remainingTokens: 7000, limitTokens: 8000, resetTokensMs: 7_500 } },
      { json: withUsage(textTurn("No findings."), 640), retries: 0, rate: {} },
    );
    const events: TraceEvent[] = [];
    const result = await reviewLean({ repo: fx.repo, ctx: fx.ctx, prompts: PROMPTS, category: "code_quality", model: "m", chat, maxTurns: 4, maxRequestBytes: 32_000, historyBytes: 8_000, maxForbiddenToolCalls: 3, onEvent: (e) => events.push(e) });
    const responses = events.filter((e) => e["event"] === "response");
    expect(responses[0]).toMatchObject({ cachedTokens: 0, remainingTokens: 7000, limitTokens: 8000, resetTokensMs: 7_500 });
    expect(responses[1]).toMatchObject({ cachedTokens: 640 });
    expect(responses[1]?.["remainingTokens"]).toBeUndefined();
    expect(result.tokensCached).toBe(640);
  });
});

describe("opt-in private transcript", () => {
  it("is off unless CRA_DEBUG_TRANSCRIPT=1", () => {
    const out = mkdtempSync(join(tmpdir(), "tx-"));
    expect(transcriptSink(out, {})).toBeUndefined();
    expect(transcriptSink(out, { CRA_DEBUG_TRANSCRIPT: "true" })).toBeUndefined();
    expect(existsSync(join(out, TRANSCRIPT_FILE))).toBe(false);
  });

  it("writes one JSON line per exchange to a file whose name says it is private", () => {
    const out = mkdtempSync(join(tmpdir(), "tx-"));
    const sink = transcriptSink(out, { CRA_DEBUG_TRANSCRIPT: "1" });
    sink?.({ attempt: 0, status: 400, request: { a: 1 }, response: "RAW" });
    sink?.({ attempt: 1, status: 200, request: { a: 1 }, response: "{}" });
    expect(TRANSCRIPT_FILE).toMatch(/private/);
    const lines = readFileSync(join(out, TRANSCRIPT_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ attempt: 0, status: 400, request: { a: 1 }, response: "RAW" });
    expect(typeof lines[0]?.["t"]).toBe("number");
  });
});
