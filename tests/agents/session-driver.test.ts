import { describe, expect, it } from "vitest";
import {
  driveSession, type DriverOptions, type MessageLike, type SessionApi, type SessionStatus, type TraceEvent,
} from "../../src/agents/session-driver.js";
import { classifyError } from "../../src/resilience/errors.js";

// A scripted OpenCode server on a virtual clock. `script` says what the session looks like at virtual time t.
interface Script {
  readonly messages: (t: number) => readonly MessageLike[];
  readonly status: (t: number) => SessionStatus | undefined;
  /** What the server does once abort() is called: from then on the session is idle. */
  readonly abortBehaviour?: "stops" | "ignored" | "throws";
  readonly deleteThrows?: boolean;
  readonly failPolls?: readonly number[];
  readonly createThrows?: boolean;
}

function fakeServer(script: Script) {
  const state = { t: 0, aborted: false, calls: [] as string[], polls: 0, prompts: [] as { stepLimited: boolean }[] };
  const api: SessionApi = {
    async create() { state.calls.push("create"); if (script.createThrows) throw new Error("create failed"); return "ses_1"; },
    async promptAsync(_id, prompt) { state.calls.push("promptAsync"); state.prompts.push({ stepLimited: prompt.stepLimited }); },
    async messages() {
      state.polls++;
      if (script.failPolls?.includes(state.polls)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
      return script.messages(state.t);
    },
    async status() {
      const s = state.aborted && script.abortBehaviour !== "ignored" ? undefined : script.status(state.t);
      return s ? { ses_1: s } : {};
    },
    async abort() {
      state.calls.push("abort");
      if (script.abortBehaviour === "throws") throw new Error("abort failed");
      state.aborted = true;
    },
    async remove() { state.calls.push("delete"); if (script.deleteThrows) throw new Error("delete failed"); },
  };
  const opts: DriverOptions = {
    pollMs: 1000, startGraceMs: 5000, cleanupWaitMs: 3000, maxProviderRetries: 5, maxPollFailures: 2,
    now: () => state.t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      state.t += ms;
      if (signal?.aborted) throw signal.reason;
    },
  };
  const trace: TraceEvent[] = [];
  return { api, opts, state, trace, sink: (e: TraceEvent) => trace.push(e) };
}

const user = (): MessageLike => ({ info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "go" }] });
const toolPart = (id: string, tool: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, type: "tool", tool, state: { status, input: { filePath: "app/services/x.py" }, output: "abc", time: { start: 10, end: 60 }, ...extra },
});
const assistant = (parts: NonNullable<MessageLike["parts"]>, info: Record<string, unknown> = {}): MessageLike => ({
  info: { role: "assistant", id: `a${Math.random()}`, time: { completed: 1 }, tokens: { input: 100, output: 10 }, finish: "stop", ...info }, parts,
});
const input = (extra: Record<string, unknown> = {}) => ({ attemptId: "code_quality#1", model: "m", prompt: "p", ...extra });
const names = (t: readonly TraceEvent[]) => t.map((e) => e.name);

describe("driveSession: normal completion", () => {
  it("returns the final text and known token usage, then cancels and deletes its session", async () => {
    const s = fakeServer({
      status: (t) => (t < 3000 ? { type: "busy" } : undefined),
      messages: (t) => (t < 3000 ? [user()] : [user(), assistant([toolPart("p1", "read", "completed")], { finish: "tool-calls" }), assistant([{ type: "text", text: "Notes." }])]),
    });
    const result = await driveSession(s.api, input(), s.opts, s.sink);
    expect(result).toMatchObject({ text: "Notes.", tokensIn: 200, tokensOut: 20, tokensKnown: true, sessionId: "ses_1" });
    expect(s.state.calls).toEqual(["create", "promptAsync", "abort", "delete"]);
  });

  it("logs each tool call once, as soon as it finishes, with sizes but no content", async () => {
    const s = fakeServer({
      status: (t) => (t < 4000 ? { type: "busy" } : undefined),
      messages: (t) => [user(), assistant([toolPart("p1", "read", "completed", { output: "x".repeat(1234) }), ...(t >= 2000 ? [toolPart("p2", "grep", "completed", { input: { pattern: "expires_at", path: "app" }, output: "y".repeat(10) })] : [])], t >= 4000 ? {} : { finish: "tool-calls", time: {} }), ...(t >= 4000 ? [assistant([{ type: "text", text: "done" }])] : [])],
    });
    await driveSession(s.api, input(), s.opts, s.sink);
    const calls = s.trace.filter((e) => e.name === "tool_call");
    expect(calls.map((c) => c.data["tool"])).toEqual(["read", "grep"]);
    expect(calls[0]?.data).toMatchObject({ attemptId: "code_quality#1", sessionId: "ses_1", status: "completed", outputBytes: 1234, input: { filePath: "app/services/x.py" } });
    expect(calls[1]?.data).toMatchObject({ outputBytes: 10, input: { pattern: "expires_at", path: "app" } });
    expect(JSON.stringify(s.trace)).not.toContain("xxxxxxxx");
  });

  it("reports usage as unknown, not zero, when the provider reported none", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [user(), assistant([{ type: "text", text: "ok" }], { tokens: { input: 0, output: 0 } })] });
    const result = await driveSession(s.api, input(), s.opts, s.sink);
    expect(result.tokensKnown).toBe(false);
  });
});

describe("driveSession: trace sanitisation", () => {
  it("keeps only path and pattern style inputs, truncates them, and drops everything else", async () => {
    const long = "p".repeat(500);
    const s = fakeServer({
      status: () => undefined,
      messages: () => [user(), assistant([
        toolPart("p1", "read", "completed", { input: { filePath: long, offset: 5, limit: 50, command: "cat /etc/passwd", content: "SECRET-SOURCE" } }),
        toolPart("p2", "bash", "error", { input: { command: "printenv" }, output: undefined, error: "Model tried to call unavailable tool 'invalid'." }),
      ], { finish: "tool-calls" }), assistant([{ type: "text", text: "x" }])],
    });
    await driveSession(s.api, input(), s.opts, s.sink);
    const text = JSON.stringify(s.trace);
    expect(text).not.toContain("SECRET-SOURCE");
    expect(text).not.toContain("printenv");
    expect(text).not.toContain("/etc/passwd");
    const read = s.trace.find((e) => e.data["tool"] === "read")?.data["input"] as Record<string, unknown>;
    expect(String(read["filePath"]).length).toBeLessThanOrEqual(201);
    expect(read).toMatchObject({ offset: 5, limit: 50 });
    expect(s.trace.find((e) => e.data["tool"] === "bash")?.data).toMatchObject({ status: "error", inputKeys: ["command"] });
  });
});

describe("driveSession: failures keep their evidence", () => {
  it("throws OpenCode's error unchanged, with the usage known so far, after logging the tool calls that preceded it", async () => {
    const s = fakeServer({
      status: () => undefined,
      messages: () => [user(), assistant([toolPart("p1", "read", "completed")], { finish: "tool-calls" }), assistant([], { finish: "error", error: { name: "ContextOverflowError", data: { message: "too big" } }, tokens: { input: 0, output: 0 } })],
    });
    const error = await driveSession(s.api, input(), s.opts, s.sink).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ContextOverflowError", usage: { input: 100, output: 10, complete: false }, sessionId: "ses_1" });
    expect(classifyError(error)).toEqual({ retryable: false, kind: "context_overflow" });
    expect(names(s.trace)).toContain("tool_call");
    expect(s.state.calls).toContain("abort");
    expect(s.state.calls).toContain("delete");
  });

  it("attaches no usage when nothing was reported", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [user(), assistant([], { error: { name: "APIError", data: { statusCode: 429 } }, tokens: { input: 0, output: 0 } })] });
    const error = (await driveSession(s.api, input(), s.opts, s.sink).catch((e: unknown) => e)) as { usage?: unknown };
    expect(error.usage).toBeUndefined();
  });
});

describe("driveSession: hidden compaction", () => {
  it("fails the attempt and records the event instead of silently continuing with a summarised investigation", async () => {
    const s = fakeServer({
      status: () => ({ type: "busy" }),
      messages: () => [user(), { info: { role: "user", id: "u2" }, parts: [{ type: "compaction", auto: true }] }, assistant([{ type: "text", text: "summary" }], { summary: true })],
    });
    const error = await driveSession(s.api, input(), s.opts, s.sink).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "CompactionObserved" });
    expect(classifyError(error)).toEqual({ retryable: false, kind: "context_overflow" });
    expect(s.trace.find((e) => e.name === "compaction_observed")?.data).toMatchObject({ attemptId: "code_quality#1", sessionId: "ses_1" });
    expect(s.state.calls).toContain("abort");
  });

  it("does not mistake the per-message diff summary object that every user message carries for compaction", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [{ info: { role: "user", id: "u", summary: { diffs: [] } }, parts: [{ type: "text", text: "go" }] }, assistant([{ type: "text", text: "fine" }])] });
    await expect(driveSession(s.api, input(), s.opts, s.sink)).resolves.toMatchObject({ text: "fine" });
  });
});

describe("driveSession: bounded provider retries", () => {
  it("logs each new OpenCode retry once and gives up past the budget, cancelling the session", async () => {
    const s = fakeServer({
      status: (t) => ({ type: "retry", attempt: Math.floor(t / 1000), message: "Rate limit reached ... Please try again in 6s.", next: t + 6000 }),
      messages: () => [user()],
    });
    const error = (await driveSession(s.api, input(), s.opts, s.sink).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ name: "RetryBudgetExceeded", status: 429 });
    expect(classifyError(error)).toMatchObject({ retryable: true, kind: "rate_limit" });
    const retries = s.trace.filter((e) => e.name === "session_retry").map((e) => e.data["retryAttempt"]);
    expect(retries).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(retries).size).toBe(retries.length);
    expect(s.trace.find((e) => e.name === "session_retry")?.data).toMatchObject({ reason: "rate_limit", delayMs: 6000 });
    expect(JSON.stringify(s.trace)).not.toContain("Rate limit reached");
    expect(s.state.calls).toContain("abort");
    expect(s.state.calls).toContain("delete");
  });
});

describe("driveSession: cancellation", () => {
  it("cancels and deletes the OpenCode session when the attempt is aborted, then rethrows the reason", async () => {
    const s = fakeServer({ status: () => ({ type: "busy" }), messages: () => [user()] });
    const controller = new AbortController();
    const reason = Object.assign(new Error("attempt timed out"), { name: "TimeoutError" });
    const run = driveSession(s.api, input({ signal: controller.signal }), { ...s.opts, sleep: async (ms, sig) => { s.state.t += ms; if (s.state.t >= 3000) controller.abort(reason); if (sig?.aborted) throw sig.reason; } }, s.sink);
    await expect(run).rejects.toBe(reason);
    expect(s.state.calls).toEqual(["create", "promptAsync", "abort", "delete"]);
    expect(s.trace.find((e) => e.name === "session_cleanup")?.data).toMatchObject({ sessionId: "ses_1", abort: "ok", idle: true, delete: "ok" });
  });

  it("does not start a session at all if the attempt was already aborted", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [] });
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("x"), { name: "AbortError" }));
    await expect(driveSession(s.api, input({ signal: controller.signal }), s.opts, s.sink)).rejects.toMatchObject({ name: "AbortError" });
    expect(s.state.calls).not.toContain("promptAsync");
  });

  it("aborts even though the session never started if the prompt itself fails", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [], createThrows: true });
    await expect(driveSession(s.api, input(), s.opts, s.sink)).rejects.toThrow("create failed");
    expect(s.state.calls).toEqual(["create"]);
  });
});

describe("driveSession: cleanup failures are visible and fail closed", () => {
  it("reports a failed abort and a session that stays active, and refuses to let a replacement start (non-retryable)", async () => {
    const s = fakeServer({ status: () => ({ type: "busy" }), messages: () => [user()], abortBehaviour: "throws" });
    const controller = new AbortController();
    const reason = Object.assign(new Error("attempt timed out"), { name: "TimeoutError" });
    const run = driveSession(s.api, input({ signal: controller.signal }), { ...s.opts, sleep: async (ms, sig) => { s.state.t += ms; if (s.state.t >= 2000) controller.abort(reason); if (sig?.aborted) throw sig.reason; } }, s.sink);
    const error = (await run.catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ name: "CleanupFailed" });
    expect(classifyError(error).retryable).toBe(false);
    expect(s.trace.find((e) => e.name === "session_cleanup")?.data).toMatchObject({ abort: "failed", idle: false });
  });

  it("reports a failed delete without failing an otherwise complete attempt", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [user(), assistant([{ type: "text", text: "ok" }])], deleteThrows: true });
    await expect(driveSession(s.api, input(), s.opts, s.sink)).resolves.toMatchObject({ text: "ok" });
    expect(s.trace.find((e) => e.name === "session_cleanup")?.data).toMatchObject({ abort: "ok", idle: true, delete: "failed" });
  });
});

describe("driveSession: transport hiccups and startup", () => {
  it("tolerates a couple of failed polls but not more, and classifies the result as transport", async () => {
    const ok = fakeServer({ status: () => undefined, messages: () => [user(), assistant([{ type: "text", text: "ok" }])], failPolls: [1, 2] });
    await expect(driveSession(ok.api, input(), ok.opts, ok.sink)).resolves.toMatchObject({ text: "ok" });
    const bad = fakeServer({ status: () => ({ type: "busy" }), messages: () => [user()], failPolls: [1, 2, 3] });
    const error = await driveSession(bad.api, input(), bad.opts, bad.sink).catch((e: unknown) => e);
    expect(classifyError(error)).toMatchObject({ retryable: true, kind: "transport" });
  });

  it("fails retryably if the session never shows any work", async () => {
    const s = fakeServer({ status: () => undefined, messages: () => [user()] });
    const error = await driveSession(s.api, input(), s.opts, s.sink).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SessionNeverStarted" });
    expect(classifyError(error)).toMatchObject({ retryable: true, kind: "transport" });
  });
});

describe("driveSession: investigation step limit", () => {
  const readStep = (n: number) => assistant([toolPart(`p${n}`, "read", "completed")], { finish: "tool-calls" });
  const done = (text = "Notes.") => assistant([{ type: "text", text }]);
  const finished = (steps: readonly MessageLike[]) => fakeServer({ status: () => undefined, messages: () => [user(), ...steps] });

  it("runs under the capped agent only when a limit is given, and records the steps used", async () => {
    const capped = finished([readStep(1), done()]);
    const result = await driveSession(capped.api, input({ stepLimit: 3 }), capped.opts, capped.sink);
    expect(capped.state.prompts).toEqual([{ stepLimited: true }]);
    expect(result).toMatchObject({ steps: 2, stepLimitReached: false });
    expect(capped.trace.find((e) => e.name === "investigation_steps")?.data).toMatchObject({ attemptId: "code_quality#1", steps: 2, stepLimit: 3, limitReached: false, outcome: "finished" });

    const free = finished([readStep(1), done()]);
    const unlimited = await driveSession(free.api, input(), free.opts, free.sink);
    expect(free.state.prompts).toEqual([{ stepLimited: false }]);
    expect(unlimited).toMatchObject({ stepLimitReached: false });
    expect(names(free.trace)).not.toContain("investigation_steps");
  });

  it("flags a session that used every allowed step, even though it ended with text, as limit reached", async () => {
    const s = finished([readStep(1), readStep(2), done("Maximum steps reached. Notes so far.")]);
    const result = await driveSession(s.api, input({ stepLimit: 3 }), s.opts, s.sink);
    expect(result).toMatchObject({ steps: 3, stepLimitReached: true, text: "Maximum steps reached. Notes so far." });
    expect(s.trace.find((e) => e.name === "investigation_steps")?.data).toMatchObject({ steps: 3, stepLimit: 3, limitReached: true, outcome: "finished" });
  });

  it("ends the attempt, with the usage so far, when the model starts another step past the limit", async () => {
    const s = fakeServer({ status: () => ({ type: "busy" }), messages: () => [user(), readStep(1), readStep(2), readStep(3), { ...readStep(4), info: { role: "assistant", id: "a4", tokens: { input: 0, output: 0 } } }] });
    const error = await driveSession(s.api, input({ stepLimit: 3 }), s.opts, s.sink).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "StepLimitExceeded", sessionId: "ses_1" });
    expect(classifyError(error)).toEqual({ retryable: false, kind: "step_limit" });
    expect((error as { usage?: unknown }).usage).toMatchObject({ complete: false, input: 300 });
    expect(s.trace.find((e) => e.name === "investigation_steps")?.data).toMatchObject({ outcome: "overrun", steps: 4, stepLimit: 3 });
    expect(s.state.calls.slice(-2)).toEqual(["abort", "delete"]);
  });

  it("does not wait for another step: a tool call on the last allowed step is already a violation", async () => {
    const s = fakeServer({ status: () => ({ type: "busy" }), messages: () => [user(), readStep(1), readStep(2)] });
    const error = await driveSession(s.api, input({ stepLimit: 2 }), s.opts, s.sink).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "StepLimitExceeded" });
    expect(s.state.t).toBeLessThanOrEqual(1000);
  });
});
