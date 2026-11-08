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
bash tests/integration/run-integration.sh <empty-work-dir> [attack] [obey] [report] [error]
```
Creates a synthetic git repo with one seeded SQL injection (`make-fixture-repo.sh`, `INJECT=1` adds a prompt-injection
comment), then for each scenario starts an isolated compose project, runs the review, asserts the outcome, and tears
the project down. It uses a recognisable DUMMY key (`gsk_STUBKEY...`), never a real one. The `report` scenario also runs
`probe-agent.sh` (22 OS-level checks) inside an agent container with the same mounts, network and limits.
Expect about 13 minutes: the `error` scenario waits out OpenCode's own retries against a provider that always returns 500.
Exit status is non-zero if any check fails.

## Live run (spends Groq tokens)
```
export GROQ_API_KEY=...            # in your shell only; passed to the proxy container by name
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
