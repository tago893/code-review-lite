# Execution lifecycle of a reviewer attempt

This describes how one reviewer attempt runs, fails and is cleaned up, and what is logged. It exists because the first
live benchmark run (Case 001) ended incomplete for reasons that were invisible in the output: see "Why this exists".

## How an attempt runs

`runWithFallback` (src/resilience/fallback.ts) runs attempts in order: each model, up to `maxRetries + 1` tries.
Every attempt gets an id (`code_quality#1`, `code_quality#2`, ...) that appears in every log line about it.

Inside an attempt, `driveSession` (src/agents/session-driver.ts) uses only supported OpenCode 1.19.5 SDK calls:

1. `session.create`, then `session.promptAsync`, which returns at once (HTTP 204).
2. Short polls of `session.messages` and `session.status` every second. No HTTP request is held open, so no client
   transport timeout can end an attempt early (see below).
3. Completion is: the session is idle, there is at least one assistant message, and every assistant message has a
   completion time. An assistant `error` ends the attempt at once with OpenCode's own error.
4. Whatever the outcome, `session.abort`, a wait until OpenCode reports the session idle, then `session.delete`.

## Cancellation and "no overlapping attempts"

- An attempt that ends for any reason, including its deadline, cancels and deletes its OpenCode session before it
  settles. On a deadline `runWithFallback` aborts the attempt's signal and **waits** (up to `abortGraceMs`, 60 s) for
  that cleanup before it rejects, so a replacement attempt cannot start alongside it.
- If the session cannot be confirmed idle after the abort, the attempt fails with a non-retryable `CleanupFailed`.
  The run stops rather than start a replacement next to a session that may still be spending provider capacity.
- Cleanup results (`abort`, `idle`, `delete`, `waitedMs`) are logged as `session_cleanup` for every attempt. A failed
  delete does not fail an otherwise complete attempt, but is visible.

## Transport timeouts versus attempt deadlines

- The attempt deadline (`codeQualityTaskMs`/`taskMs`, scaled by `REVIEW_TIMEOUT_SCALE`) is enforced by the abort
  signal in the poll loop, not by HTTP.
- Each HTTP call to the local OpenCode server has its own short timeout (`session.requestTimeoutMs`, 30 s, not scaled).
  It guards against a wedged local server. A call that hits it fails as `TransportTimeoutError`.
- Failures of our own HTTP calls (resets, `fetch failed`, undici timeouts, the above) are classified `transport`.
  `server` is reserved for an HTTP 5xx from the provider. Both are retryable.
- Background: the original design held one `session.prompt` request open for the whole attempt. Node's fetch (undici)
  gives up on a request with no response headers after about 293 s (reproduced: 292.8 s, `UND_ERR_HEADERS_TIMEOUT`),
  far below the 1,800 s attempt deadline. The SDK sets `req.timeout = false`, which has no effect in Node.

## Bounded retries

OpenCode retries a failing provider call (for example a 429) by itself, with the provider's retry-after delay, for as
long as it is allowed to. The driver ends the attempt once OpenCode has retried more than `REVIEW_SESSION_RETRIES`
times (default 5, range 1-20) with `RetryBudgetExceeded`, a retryable `rate_limit` error carrying the delay OpenCode
was about to wait. The outer `runWithFallback` budget (2 retries per model, then the fallback model) is unchanged.

## Oversized requests and compaction

- OpenCode treats any HTTP 413 as a context overflow. With its default settings it then silently summarises the
  conversation (a separate no-tools request) and carries on with the summary. A compacted investigation is not
  equivalent to an uncompacted one, so automatic compaction and pruning are **disabled** (`compaction.auto=false`,
  `prune=false`). A 413 now ends the attempt as `ContextOverflowError` (non-retryable, never repeated unchanged,
  never retried on the fallback model).
- If a compaction is observed anyway (it should not be), the attempt fails as `CompactionObserved` and a
  `compaction_observed` event is logged. The review is then incomplete, not degraded-but-complete.
- **Known limitation: tool output size cannot be bounded through OpenCode 1.19.5 configuration.** The SDK has
  `tool_output.max_lines` / `max_bytes`, but they do not apply to `read` or `grep`: measured with a 6,000-byte limit,
  `read` still returned its own hard cap (50 KB / 2,000 lines, "use offset=N to continue") and grep was unchanged.
  One large `read` can therefore push a request past a free-tier limit (8,000 tokens per minute is roughly 28 KB).
  Bounding it would need a custom read tool or a prompt change, which are outside this hardening pass.
  What CRA does instead: it logs every tool call's output size as it finishes, and an overflow now fails visibly.

## What is logged (all in run.jsonl; nothing here contains source text)

| event | key fields |
|---|---|
| `attempt_start` / `attempt_succeeded` | `attemptId`, `reviewer`, `model`, `tryNo` |
| `attempt_failed` | `attemptId`, `kind`, `decision` (`retry_same_model`, `fallback_model`, `exhausted`, `stop_not_retryable`), `delayMs`, `usage` |
| `attempt_session` | `attemptId`, `sessionId`, `model` |
| `tool_call` | `attemptId`, `sessionId`, `tool`, `status`, `input` (path / pattern / offset / limit only, truncated), `inputKeys` (names of dropped arguments), `outputBytes`, `durationMs` |
| `session_retry` | `retryAttempt`, `reason` (`rate_limit`/`server`/`other`), `delayMs` |
| `compaction_observed` | `sessionId`, `messages` |
| `session_cleanup` | `abort`, `idle`, `delete`, `waitedMs` |

Tool calls are logged when they finish, so they survive a failed attempt.

The credential proxy logs, per request, an opaque `rid` shared by `request`, `upstream`, `provider_error` and
`response_end`, with `ttfbMs`/`totalMs`, `retryAfter`, and the validated `x-ratelimit-*` header values. For a 4xx it
logs only the error `type`/`code`, the limit `window` (TPM/TPD/RPM/RPD) and the `limit`/`used`/`requested` numbers,
never the message. That is what distinguishes a per-minute limit from a daily one.

**Correlation limit:** OpenCode 1.19.5 sends no session identifier to the provider, so a proxy `rid` cannot be tied to
a `sessionId` by id. Because attempts no longer overlap, the proxy and run logs are correlated by time window
(`attempt_start` to `attempt_failed`/`attempt_succeeded`).

## Token usage: known, partial, unknown

- A reviewer's tokens are the sum of what its attempts are known to have used, including failed ones.
- Usage from an attempt that was cut short is a **lower bound**. An attempt whose provider reported no usage is
  **unreported**, not zero. The report says `tokens: unknown (N runs reported no usage)`,
  `tokens: at least X in / Y out (lower bound; ...)`, or the plain figure when everything reported fully.
- OpenCode reports tokens per completed assistant message. A message in flight when an attempt is cancelled is not
  counted, which is why failed-attempt usage is always a lower bound.

## Why this exists

The Case 001 run (7 Nov 2026) made 57 provider requests (18 x 200, 38 x 429, 1 x 413) and reported
`tokens: 0 in / 0 out`. Verified causes: (1) attempts ended after about 293 s on undici's header timeout, (2) the
sessions of failed attempts kept retrying and overlapped their replacements, (3) the one 413 was absorbed by OpenCode's
silent compaction, and (4) tool calls were collected only after a successful prompt, so none survived the failure.

Session overlap (2) was verified by session id, but its contribution to the 38 HTTP 429 responses was not measured.
The 429s may equally come from the single investigation's own request rate and size against the provider's limits.
