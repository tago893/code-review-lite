import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, startHeartbeat } from "../../src/observability/log.js";
import { fake } from "../safety/fakes.js";

const capture = (): { lines: string[]; sink: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, sink: (line) => void lines.push(line) };
};

describe("createLogger", () => {
  it("writes one valid JSON object per line, without embedded newlines", () => {
    const { lines, sink } = capture();
    createLogger(sink, { now: () => new Date("2026-11-07T10:00:00.000Z") }).event("reviewer_done", { reviewer: "sec", note: "a\nb", n: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/\n/);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ ts: "2026-11-07T10:00:00.000Z", event: "reviewer_done", reviewer: "sec", note: "a\nb", n: 3 });
  });

  it("redacts secrets in values, nested values and keys, and the line stays valid JSON", () => {
    const { lines, sink } = capture();
    const key = fake.groq();
    const pw = fake.password();
    createLogger(sink).event("x", {
      msg: `calling with ${key}`,
      nested: { list: [`Authorization: Bearer ${fake.github()}`], connection: `postgres://u:${pw}@h/db` },
      password: pw,
      [key]: "k",
    });
    const line = lines[0] ?? "";
    expect(line).not.toContain("gsk_");
    expect(line).not.toContain(pw);
    expect(line).not.toContain("ghp_");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("redacts a secret passed as the event name", () => {
    const { lines, sink } = capture();
    createLogger(sink).event(`evt ${fake.groq()}`, {});
    expect(lines[0]).not.toContain("gsk_");
  });

  it("does not throw on circular data, BigInt or a failing sink, and records that a line was lost", () => {
    const { lines, sink } = capture();
    const logger = createLogger(sink);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => logger.event("c", circular)).not.toThrow();
    expect(() => logger.event("b", { n: 10n })).not.toThrow();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    const failing = createLogger(() => { throw new Error("disk full"); });
    expect(() => failing.event("x", {})).not.toThrow();
    expect(failing.droppedLines()).toBe(1);
  });

  it("truncates very long values", () => {
    const { lines, sink } = capture();
    createLogger(sink).event("x", { big: "y".repeat(100_000) });
    expect(lines[0]?.length).toBeLessThan(10_000);
  });
});

describe("startHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits a heartbeat on every interval and stops when asked, idempotently", () => {
    const { lines, sink } = capture();
    const stop = startHeartbeat(createLogger(sink), 30_000);
    vi.advanceTimersByTime(30_000 * 3);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ event: "heartbeat", elapsedMs: 90_000 });
    stop();
    stop();
    vi.advanceTimersByTime(30_000 * 3);
    expect(lines).toHaveLength(3);
  });

  it("rejects a non-positive interval", () => {
    expect(() => startHeartbeat(createLogger(() => undefined), 0)).toThrow();
  });
});
