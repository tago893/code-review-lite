# Development handoff

## State
- Last commit: `e893d41` (bounded MCP, security isolation, request budgets; 657 unit tests, 16 provider-free integration scenarios).
- **Uncommitted, awaiting review/commit (separate focused commit):** two small controls.
  - `REVIEW_MAX_RETRIES` (0-5, default 2): whole-attempt retries per model. `0` = exactly one attempt per reviewer/coordinator, no retry, no fallback model (`attemptModels` in `src/config.ts`).
  - `REVIEW_DEADLINE_MINUTES` (1-240, default = overall timeout, 25 min x `REVIEW_TIMEOUT_SCALE`): hard run-wide deadline. `startDeadline` (`src/resilience/deadline.ts`) aborts a signal; `runWithFallback` propagates it to the active attempt (existing abort -> OpenCode session cancel/cleanup, bounded by `abortGraceMs`), starts nothing new, never retries. Pipeline then ends `REVIEW INCOMPLETE` / `not_determined` / exit 2 with reason `run_deadline_exceeded`. The verifier also receives the signal.
- Not changed: prompts, models, MCP tooling, benchmark, ground truth, scoring.

## Verification (done)
- Node 22 Docker unit run: 654 pass, 10 fail. The 10 are all `tests/mcp/tools.test.ts` (ripgrep is absent from the bare `node:22-slim` image used by `scripts/test-in-docker.sh`); the same 10 fail on the previous commit (647 pass / 10 fail), so it is an image gap, not a regression.
- Integration `deadline` scenario (stub `ratelimit_slow`, `REVIEW_DEADLINE_MINUTES=1`): PASS, 0 failures. Review ended at 60 s: REVIEW INCOMPLETE, not_determined, exit 2, `run_deadline_exceeded`; final attempt a non-retryable abort; 2/2 sessions cleaned up; none started after the deadline.
- `docker/compose.yml` now passes `REVIEW_MAX_RETRIES` and `REVIEW_DEADLINE_MINUTES` to the agent.

## Known limitations
- Deadline can overshoot by up to `abortGraceMs` (60 s) if session cleanup hangs.
- `REVIEW_MAX_RETRIES=0` also disables the fallback model (single attempt).
- Windows host `vitest` has 31 POSIX-only failures (pre-existing); use Docker.

## Next action
Event Booking Case 001 evaluation (awaiting approval; do not call Groq before then). No more infrastructure work.

## Bounded tool-result history (off by default)

`REVIEW_HISTORY_BUDGET_BYTES` (0/unset = off; otherwise 2000-500000, e.g. 8000) keeps only the newest tool-result bodies that fit the budget in each model request and replaces older ones with a short reference (`[cra:pruned tool=... path=... lines=... bytes=... sha256=...]`). It is a trusted CRA OpenCode plugin (`src/agents/history-plugin.ts`) registered only from inline config. Stored sessions, the snapshot and citation verification are untouched; the model can repeat a call to see a result again.

Fail-closed: `docker/run.sh` sets `PROXY_REQUIRE_HISTORY=1` and a default `PROXY_MAX_REQUEST_BYTES=32000` when the budget is on. The proxy refuses (403 `history_pruning_inactive`, before the request budget and the upstream) any tool-enabled request without the `x-cra-history` stamp the plugin adds only after a successful prune, and any tool-enabled request over the ceiling. The driver also fails the attempt (tooling, non-retryable) on a recorded plugin error, a silent plugin (no prune after the start grace), or fewer prunes than model requests.

Limits: running compose directly with the budget set but without `run.sh` has no proxy gate (the driver still fails the attempt, but only after the fact). The stamp assumes OpenCode runs `chat.headers` after the transform hook for the same request (true in 1.19.5; a change would cause refusals, not leaks). Growth is slowed (~0.5 KB/request in scripted runs vs ~4 KB), not eliminated. Bytes are not tokens. Not yet evaluated with a real model.

Next action: one separately approved live Case 001 run with `REVIEW_HISTORY_BUDGET_BYTES=8000`.
