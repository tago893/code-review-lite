# Integration checks (real containers)

These scripts run the real CLI, the real OpenCode 1.19.5 SDK, and the real prep, agent and proxy containers on the
real network topology. Only the model is replaced (by `stub-groq.mjs`) in the scripted scenarios.

## Prerequisites
- Docker Engine 28+ with Compose v2 (tested on Docker Desktop for Windows). Linux and macOS are untested.
- A bash shell (Git Bash on Windows). Run from the repository root.
- Network access on first build only (npm, apt). The scripted scenarios need no provider key and no internet at run time.
- Enough rate limit for a live run: see "Live run" below.

## Scripted scenarios (no key, no tokens)
```
bash tests/integration/run-integration.sh <empty-work-dir> [attack] [obey] [report] [error] [overflow] [ratelimit] [abandon] [stepcap] [stepcap_stubborn] [hostile] [mcpdown] [budget] [offline]
```
Step-cap scenarios: `stepcap` (a model that never stops by itself but obeys OpenCode's last-step "text only" instruction;
`REVIEW_INVESTIGATION_STEPS=3`: exactly 3 model calls, review incomplete, unchanged files still readable) and
`stepcap_stubborn` (a model that ignores the instruction: the driver ends the attempt, non-retryable, review incomplete).
Tooling and isolation scenarios: `attack` (the model is offered only the four `cra_*` tools; built-in and MCP escapes are
all refused), `hostile` (a repository with executable plugins/tools, an MCP entry, an AGENTS.md injection and a report
forgery: executes under a raw OpenCode, inert under CRA's launch), `mcpdown` (the MCP server cannot start: review
incomplete, no tool-enabled request reaches the model), `budget` (`PROXY_MAX_REQUESTS=3`: three requests forwarded, one
refused, no retry, no compaction, review incomplete), `offline` (live mode without `CRA_ALLOW_LIVE=1` is refused; a
real-looking key in stub mode is refused by the proxy; the stub-mode proxy cannot reach api.groq.com, example.com or a
raw IP).
Lifecycle scenarios (see `docs/execution-lifecycle.md`): `overflow` (provider answers 413: the request is sent once,
no compaction, tool call still logged, non-retryable, usage reported as unknown), `ratelimit` (always 429, run with
`REVIEW_SESSION_RETRIES=2`: six attempts, bounded provider requests, every session cleaned up) and `abandon`
(`abandon-probe.mjs` runs inside the agent container against the real OpenCode and checks by session id that an
abandoned attempt leaves no session behind and never overlaps its replacement).
Creates a synthetic git repo with one seeded SQL injection (`make-fixture-repo.sh`, `INJECT=1` adds a prompt-injection
comment), then for each scenario starts an isolated compose project, runs the review, asserts the outcome, and tears
the project down. It uses a recognisable DUMMY key (`gsk_STUBKEY...`), never a real one. The `report` scenario also runs
`probe-agent.sh` (22 OS-level checks) inside an agent container with the same mounts, network and limits.
Expect about 13 minutes: the `error` scenario waits out OpenCode's own retries against a provider that always returns 500.
Exit status is non-zero if any check fails.

## Live run (spends Groq tokens)
```
export GROQ_API_KEY=...            # in your shell only; passed to the proxy container by name
export CRA_ALLOW_LIVE=1            # explicit authorization; without it docker/run.sh refuses to run live
export UPSTREAM_URL=https://api.groq.com   # explicit; the proxy has no default upstream
bash tests/integration/make-fixture-repo.sh <empty-dir>      # prints BASE= and HEAD=
REVIEW_AGENTS=security REVIEW_TIMEOUT_SCALE=3 \
  bash docker/run.sh --repo <empty-dir> --base <BASE> --head <HEAD> --out-dir <out> --keep
```
On the free tier (8,000 tokens per minute) one security-only review of this tiny diff took about 18 minutes. All three
reviewers do not fit. Send only synthetic or approved repositories to the hosted model. Do not run
`docker compose config` or `docker inspect` on the running proxy in a shared terminal: its environment holds the key.

## Accepted deviations from the Task 10 plan
- `docker/run.sh` (bash) instead of `docker/run.ps1`.
- Bash scenario scripts instead of a Vitest `sandbox.test.ts` wrapper (`INTEGRATION=1`).
- The README security section lives in `docs/workspace-security.md`; there is no top-level `README.md` yet (Task 12).
- Only one live seeded-bug run was made; the plan's two live injection benchmark cases belong to Task 11.
