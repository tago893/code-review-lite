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
