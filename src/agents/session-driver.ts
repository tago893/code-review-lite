import { createHash } from "node:crypto";
import { TRANSPORT_MARKER } from "../resilience/errors.js";
import type { HistoryState } from "./history-stats.js";

// Runs one OpenCode Phase 1 session without holding a long HTTP request open. The prompt is submitted with
// promptAsync and observed by short polls, so no single request can hit a client transport timeout, tool calls can be
// logged as they finish (even if the attempt later fails), and the session can always be cancelled and removed.
// Everything here talks to OpenCode through the small SessionApi, which the real SDK adapter implements.

export type SessionStatus =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | { readonly type: "retry"; readonly attempt: number; readonly message?: string; readonly next?: number };

export interface PartLike {
  readonly id?: string;
  readonly type?: string;
  readonly tool?: string;
  readonly text?: string;
  readonly state?: {
    readonly status?: string;
    readonly input?: Readonly<Record<string, unknown>>;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly time?: { readonly start?: number; readonly end?: number };
  };
}

export interface MessageLike {
  readonly info: {
    readonly id?: string;
    readonly role?: string;
    readonly error?: unknown;
    readonly finish?: string | null;
    readonly summary?: unknown;
    readonly tokens?: { readonly input?: number; readonly output?: number };
    readonly time?: { readonly completed?: number };
  };
  readonly parts?: readonly PartLike[];
}

export interface SessionApi {
  create(): Promise<string>;
  promptAsync(sessionId: string, input: { readonly model: string; readonly text: string; readonly stepLimited: boolean }): Promise<void>;
  messages(sessionId: string): Promise<readonly MessageLike[]>;
  /** Sessions that are not idle. An idle session is absent from the result. */
  status(): Promise<Readonly<Record<string, SessionStatus>>>;
  abort(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

/** A sanitised diagnostic event. Names, ids, sizes and counts only: never source text or provider message text. */
export interface TraceEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface DriverOptions {
  readonly pollMs: number;
  /** How long a prompted session may show no assistant work before the attempt is declared not started. */
  readonly startGraceMs: number;
  /** How long to wait, after abort, for OpenCode to report the session idle. */
  readonly cleanupWaitMs: number;
  /** OpenCode retries a failing provider call by itself; more than this many retries ends the attempt. */
  readonly maxProviderRetries: number;
  /** Consecutive failed polls tolerated before the attempt fails as a transport error. */
  readonly maxPollFailures: number;
  /**
   * Set when tool-result pruning is configured. The driver then refuses to call an investigation complete unless the
   * plugin recorded a successful prune for every model request, and fails it if the plugin recorded an error.
   */
  readonly history?: { readonly read: () => HistoryState };
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface DriveInput {
  readonly attemptId: string;
  readonly model: string;
  readonly prompt: string;
  /**
   * Most agent steps (model calls) this session may take. Set for reviewer Phase 1, which then runs under the capped
   * "investigator" agent. Unset for the coordinator. OpenCode only asks the model to stop at the limit; the driver
   * enforces it (see StepLimitExceeded).
   */
  readonly stepLimit?: number;
  readonly signal?: AbortSignal;
}

export interface DriveResult {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** False when the provider reported no usage at all; the token counts are then not "zero", they are unknown. */
  readonly tokensKnown: boolean;
  readonly sessionId: string;
  /** Model calls the session made. */
  readonly steps: number;
  /** The session used every step it was allowed. The investigation may have been cut short: it is not proof of completeness. */
  readonly stepLimitReached: boolean;
}

const MAX_PATH_CHARS = 200;
const MAX_ERROR_CHARS = 200;
const KEPT_INPUT_KEYS: ReadonlySet<string> = new Set(["filePath", "path", "pattern", "include", "glob", "offset", "limit"]);
const CLEANUP_POLL_MS = 250;

export async function driveSession(api: SessionApi, input: DriveInput, opts: DriverOptions, sink: (event: TraceEvent) => void): Promise<DriveResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const { attemptId, signal } = input;
  const emit = (name: string, data: Record<string, unknown>): void => {
    try { sink({ name, data: { attemptId, ...data } }); } catch { /* diagnostics must never break a review */ }
  };

  signal?.throwIfAborted();
  const sessionId = await api.create();
  emit("attempt_session", { sessionId, model: input.model });

  let failure: unknown;
  let lastUsage: Usage = { input: 0, output: 0, known: false };
  try {
    signal?.throwIfAborted();
    await api.promptAsync(sessionId, { model: input.model, text: input.prompt, stepLimited: input.stepLimit !== undefined });
    const promptedAt = now();
    const seenTools = new Set<string>();
    const historyBase = input.stepLimit !== undefined ? opts.history?.read() : undefined;
    const checkHistory = (requests: number, final: boolean): void => {
      if (historyBase === undefined || opts.history === undefined) return;
      const seen = opts.history.read();
      const prunes = seen.prunes - historyBase.prunes;
      const errors = seen.errors - historyBase.errors;
      // A prune runs before the first model request, so a session that has shown no prune after the start grace has a
      // plugin that is silent or whose hook failed without saying so. Fail now instead of waiting for the attempt timeout.
      const silent = prunes === 0 && now() - promptedAt >= opts.startGraceMs;
      const verdict = errors > 0 ? "plugin_error" : silent ? "plugin_silent" : final && (!seen.loaded || prunes < requests) ? "not_invoked_for_every_request" : "ok";
      if (final || verdict !== "ok") emit("history_pruning", { sessionId, verdict, modelRequests: requests, prunes, stamps: seen.stamps - historyBase.stamps, errors, maxToolResults: seen.maxToolResults, maxKeptBytes: seen.maxKeptBytes, savedBytes: seen.savedBytes - historyBase.savedBytes, lastPruned: seen.lastPruned });
      if (verdict !== "ok") throw Object.assign(new Error(`history pruning ${verdict}`), { name: "HistoryPruningFailed" });
    };
    let lastRetryAttempt = 0;
    let pollFailures = 0;

    for (;;) {
      await sleep(opts.pollMs, signal);
      let messages: readonly MessageLike[];
      let status: SessionStatus | undefined;
      try {
        [messages, status] = await Promise.all([api.messages(sessionId), api.status().then((all) => all[sessionId])]);
        pollFailures = 0;
      } catch (error) {
        if (++pollFailures > opts.maxPollFailures) throw error;
        continue;
      }
      lastUsage = usageOf(messages);
      traceTools(messages, seenTools, (data) => emit("tool_call", { sessionId, ...data }));

      if (messages.some(isCompaction)) {
        emit("compaction_observed", { sessionId, messages: messages.length, note: "automatic compaction is disabled; its occurrence means the investigation is no longer equivalent to an uncompacted one" });
        throw Object.assign(new Error("compaction observed"), { name: "CompactionObserved", status: 413 });
      }
      const errored = messages.find((m) => m.info.role === "assistant" && m.info.error !== undefined && m.info.error !== null);
      if (errored) throw errored.info.error;

      const steps = messages.filter((m) => m.info.role === "assistant");
      checkHistory(steps.length, false);
      if (input.stepLimit !== undefined && overranStepLimit(steps, input.stepLimit)) {
        emit("investigation_steps", { sessionId, steps: steps.length, stepLimit: input.stepLimit, limitReached: true, outcome: "overrun" });
        throw Object.assign(new Error("step limit exceeded"), { name: "StepLimitExceeded" });
      }

      if (status?.type === "retry" && status.attempt !== lastRetryAttempt) {
        lastRetryAttempt = status.attempt;
        const delayMs = typeof status.next === "number" ? Math.max(0, status.next - now()) : undefined;
        emit("session_retry", { sessionId, retryAttempt: status.attempt, reason: retryReason(status.message), ...(delayMs === undefined ? {} : { delayMs }) });
        if (status.attempt > opts.maxProviderRetries) {
          throw Object.assign(new Error("provider retry budget exceeded"), {
            name: "RetryBudgetExceeded", status: 429, ...(delayMs === undefined ? {} : { headers: { "retry-after-ms": String(delayMs) } }),
          });
        }
      }

      if (status !== undefined && status.type !== "idle") continue;
      const assistants = messages.filter((m) => m.info.role === "assistant");
      if (assistants.length === 0) {
        if (now() - promptedAt >= opts.startGraceMs) {
          throw Object.assign(new Error("session never started"), { name: "SessionNeverStarted", code: TRANSPORT_MARKER });
        }
        continue;
      }
      if (!assistants.every((m) => m.info.time?.completed !== undefined)) continue;
      checkHistory(assistants.length, true);
      const limitReached = input.stepLimit !== undefined && assistants.length >= input.stepLimit;
      if (input.stepLimit !== undefined) emit("investigation_steps", { sessionId, steps: assistants.length, stepLimit: input.stepLimit, limitReached, outcome: "finished" });
      return { text: finalText(assistants), tokensIn: lastUsage.input, tokensOut: lastUsage.output, tokensKnown: lastUsage.known, sessionId, steps: assistants.length, stepLimitReached: limitReached };
    }
  } catch (error) {
    failure = error;
    throw annotate(error, sessionId, lastUsage);
  } finally {
    const cleaned = await cleanup(api, sessionId, opts, now, sleep, emit);
    if (failure !== undefined && !cleaned.idle) {
      // A session that cannot be confirmed idle may still be consuming provider capacity. Do not let a replacement
      // attempt start alongside it: end the run with a non-retryable error.
      // eslint-disable-next-line no-unsafe-finally
      throw annotate(Object.assign(new Error("session could not be confirmed stopped"), { name: "CleanupFailed" }), sessionId, lastUsage);
    }
  }
}

interface Usage {
  readonly input: number;
  readonly output: number;
  readonly known: boolean;
}

function usageOf(messages: readonly MessageLike[]): Usage {
  let input = 0;
  let output = 0;
  for (const m of messages) {
    if (m.info.role !== "assistant") continue;
    input += num(m.info.tokens?.input);
    output += num(m.info.tokens?.output);
  }
  return { input, output, known: input + output > 0 };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function annotate(error: unknown, sessionId: string, usage: Usage): unknown {
  if (error === null || typeof error !== "object") return error;
  const extra: Record<string, unknown> = { sessionId };
  if (usage.known) extra["usage"] = { input: usage.input, output: usage.output, complete: false };
  try {
    return Object.assign(error, extra);
  } catch {
    return error; // frozen: keep the original rather than lose the failure
  }
}

/**
 * True when the model kept using tools past the limit: a further step began after the last allowed one, or the last
 * allowed step itself asked for a tool. A compliant model writes text on its last step.
 */
function overranStepLimit(steps: readonly MessageLike[], limit: number): boolean {
  if (steps.length > limit) return true;
  const last = steps[limit - 1];
  return last !== undefined && ((last.parts ?? []).some((p) => p.type === "tool") || last.info.finish === "tool-calls");
}

const isCompaction = (m: MessageLike): boolean =>
  (m.parts ?? []).some((p) => p.type === "compaction") || (m.info.role === "assistant" && m.info.summary === true);

function finalText(assistants: readonly MessageLike[]): string {
  const stopped = assistants.filter((m) => m.info.finish === "stop");
  const last = (stopped.length > 0 ? stopped : assistants).at(-1);
  return (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function retryReason(message: string | undefined): "rate_limit" | "server" | "other" {
  if (message === undefined) return "other";
  if (/rate.?limit|too many requests|\b429\b|tokens per minute|requests per/i.test(message)) return "rate_limit";
  if (/\b5\d\d\b|overloaded|unavailable|internal server/i.test(message)) return "server";
  return "other";
}

function traceTools(messages: readonly MessageLike[], seen: Set<string>, emit: (data: Record<string, unknown>) => void): void {
  messages.forEach((m, mi) => {
    (m.parts ?? []).forEach((p, pi) => {
      if (p.type !== "tool" || (p.state?.status !== "completed" && p.state?.status !== "error")) return;
      const key = p.id ?? `${mi}:${pi}`;
      if (seen.has(key)) return;
      seen.add(key);
      const output = p.state.output;
      const error = typeof p.state.error === "string" ? p.state.error.slice(0, MAX_ERROR_CHARS) : undefined;
      const start = p.state.time?.start;
      const end = p.state.time?.end;
      const { kept, dropped } = keepInput(p.state.input ?? {});
      emit({
        tool: p.tool ?? "unknown", status: p.state.status, input: kept, ...(dropped.length > 0 ? { inputKeys: dropped } : {}),
        outputBytes: typeof output === "string" ? Buffer.byteLength(output) : 0,
        ...(typeof output === "string" ? { outputSha256: createHash("sha256").update(output).digest("hex").slice(0, 12) } : {}),
        ...(typeof start === "number" && typeof end === "number" ? { durationMs: Math.max(0, end - start) } : {}),
        ...(error === undefined ? {} : { error }),
      });
    });
  });
}

/** Only path, pattern and range arguments are logged, truncated. Other argument names are listed, never their values. */
function keepInput(raw: Readonly<Record<string, unknown>>): { kept: Record<string, string | number>; dropped: string[] } {
  const kept: Record<string, string | number> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (KEPT_INPUT_KEYS.has(key) && typeof value === "string") kept[key] = value.length > MAX_PATH_CHARS ? `${value.slice(0, MAX_PATH_CHARS)}…` : value;
    else if (KEPT_INPUT_KEYS.has(key) && typeof value === "number") kept[key] = value;
    else dropped.push(key);
  }
  return { kept, dropped: dropped.sort() };
}

interface Cleanup {
  readonly idle: boolean;
}

/** Cancels the session, waits for OpenCode to report it idle, then deletes it. Never throws; reports what happened. */
async function cleanup(
  api: SessionApi, sessionId: string, opts: DriverOptions, now: () => number, sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  emit: (name: string, data: Record<string, unknown>) => void,
): Promise<Cleanup> {
  const started = now();
  let abort: "ok" | "failed" = "ok";
  let del: "ok" | "failed" = "ok";
  let idle = false;
  try { await api.abort(sessionId); } catch { abort = "failed"; }
  for (;;) {
    try { idle = (await api.status())[sessionId] === undefined; } catch { idle = false; }
    if (idle || now() - started >= opts.cleanupWaitMs) break;
    await sleep(CLEANUP_POLL_MS);
  }
  try { await api.remove(sessionId); } catch { del = "failed"; }
  emit("session_cleanup", { sessionId, abort, idle, delete: del, waitedMs: now() - started });
  return { idle };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
