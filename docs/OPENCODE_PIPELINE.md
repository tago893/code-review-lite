# CRA OpenCode pipeline (V1 guide)

> This is the original multi-reviewer pipeline built on OpenCode (`src/`, `docker/`). It is kept as is. The current demo is the
> lean single-reviewer experiment described in the [README](../README.md). Links below that mention `README.md` refer to this file.

A containerised AI code reviewer. It reviews the diff between two commits of a local Git repository with up to three
reviewers (`code_quality`, `security`, `performance`), checks their findings, and writes a report. The model is called
through a credential proxy; the agent container never holds your API key and can only read a sanitised snapshot.

Status: V1. It works end to end on synthetic and small repositories. **Cross-file bug detection (a defect that shows up
in an unchanged file because of the change) is not yet proven.** See "Known limits".

## Prerequisites
- Docker Engine 28+ with Compose v2 (tested on Docker Desktop for Windows; Linux and macOS are untested).
- A bash shell (Git Bash on Windows) and Git. Run everything from this repository's root.
- A Groq API key. Network access is needed only for the first image build and for the model calls.
- The repository you review must be a local Git checkout with a clean working tree and `HEAD` checked out.

No `npm install` is needed to run a review; the images build themselves.

## Run a review
```bash
export GROQ_API_KEY=...                       # your shell only; passed to the proxy container by name
export CRA_ALLOW_LIVE=1                       # explicit permission to spend real tokens
export UPSTREAM_URL=https://api.groq.com      # explicit; the proxy has no default upstream
export REVIEW_HISTORY_BUDGET_BYTES=8000       # recommended, see "Bounded history"
export REVIEW_TIMEOUT_SCALE=3                 # recommended on the free tier

bash docker/run.sh --repo /path/to/repo --base <base-commit> --head <head-commit> --out-dir ./review-out
```
Add `REVIEW_AGENTS=security` (or a comma-separated subset) to run fewer reviewers. Without a key or without
`CRA_ALLOW_LIVE=1` the script refuses to run live. Use `--keep` to keep the agent container for inspection.

Exit codes: `0` complete review, `2` incomplete or failed (including a failed prepare step), `64` bad usage.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | required | Held only by the proxy container. |
| `CRA_ALLOW_LIVE` / `UPSTREAM_URL` | required for live runs | Must be `1` and `https://api.groq.com`. |
| `REVIEW_AGENTS` | all planned | Subset of `code_quality,security,performance`. The report says the run was restricted. |
| `REVIEWER_MODEL` | `openai/gpt-oss-20b` | Model for the reviewers. |
| `COORDINATOR_MODEL` / `VERIFIER_MODEL` / `FALLBACK_MODEL` | `openai/gpt-oss-120b` | Coordinator, verifier and retry fallback. |
| `REVIEW_INVESTIGATION_STEPS` | 10 (1-50) | Most model calls one reviewer investigation may take. |
| `REVIEW_HISTORY_BUDGET_BYTES` | 0 = off (or 2000-500000) | See "Bounded history". |
| `REVIEW_MAX_RETRIES` | 2 (0-5) | Whole-investigation retries per model. At 0: one attempt, no fallback model. |
| `REVIEW_SESSION_RETRIES` | 5 (1-20) | Retries of one failing provider call inside an attempt. |
| `REVIEW_DEADLINE_MINUTES` | 25 x scale (1-240) | Hard run-wide deadline; on expiry the run is cancelled, cleaned up and incomplete. |
| `REVIEW_TIMEOUT_SCALE` | 1 (1-10) | Multiplies task and overall timeouts, for low tokens-per-minute tiers. |
| `PROXY_MAX_REQUESTS` | 200 | Hard cap on provider requests per run. |

## Bounded history
Each model request normally re-sends every earlier tool result, so a long investigation grows and can exceed the
free-tier limit (HTTP 413). With `REVIEW_HISTORY_BUDGET_BYTES=8000`, only the newest tool results that fit 8,000 bytes
are sent in full; older ones become a short reference (tool, path, line range, size, hash) and the model repeats the
call if it needs them again. In scripted runs this cut the largest request from 171 KB to 28 KB over 40 tool calls.
Bytes are not tokens, and the feature has not yet been evaluated with a real model.

**Pruning-enabled runs must use `docker/run.sh`.** It switches on the proxy protections that make pruning fail closed:
the proxy refuses tool-enabled requests that the pruning plugin did not stamp, and requests over
`PROXY_MAX_REQUEST_BYTES` (default 32000 when pruning is on). Invoking Compose directly with the budget set does not
enable these, so a broken plugin could then send full history (the driver would still fail the attempt, but after the
fact). If pruning cannot run, the review ends incomplete; it never silently continues unpruned.

## Output
`--out-dir` (default `./review-out`) receives:
- `report.md` — completion, verdict, reasons and findings (file, line, evidence, severity).
- `metrics.json` — token usage (a lower bound when the provider reported none), findings counts, retries, fallbacks, duration.
- `run.jsonl` — the execution log: attempts, every tool call (tool, path, sizes, hashes), step counts, retry and
  cleanup decisions, and `history_pruning` counters. No source text or key.
- `proxy.log` — request sizes, rate-limit headers, 413/429 facts. No request bodies.

## Reading the result
- **Completion `complete`**: every planned reviewer finished. The verdict is one of `approved`, `approved_with_comments`
  (suggestions or one warning), `minor_issues` (two or more warnings), `significant_concerns` (an independently
  confirmed critical finding). Exit 0.
- **Completion `incomplete`, verdict `not_determined`**: the review did not finish (step limit, rate limit/413, request
  budget, deadline, tooling or pruning failure, cancelled). **This is not an approval and not a finding of no bugs.**
  The report names the reason (for example `investigation_truncated`, `model_budget`, `model_tooling`). Findings listed
  are partial. Exit 2.
- A restricted run (`REVIEW_AGENTS`) says so in the report's Notes; it is not a full review.
- `approved` means no confirmed problem was found by the reviewers that ran, not that the change is correct.

## Demonstration (seeded SQL injection)
A tiny synthetic repository with one seeded SQL injection (`src/users.ts` line 4, reached from an unchanged route in
`src/server.ts`). Nothing real is sent to the model.
```bash
export GROQ_API_KEY=...  CRA_ALLOW_LIVE=1  UPSTREAM_URL=https://api.groq.com
export REVIEW_HISTORY_BUDGET_BYTES=8000 REVIEW_TIMEOUT_SCALE=3 REVIEW_AGENTS=security

eval "$(bash tests/integration/make-fixture-repo.sh ./demo-repo | sed 's/^/export /')"   # sets BASE and HEAD
bash docker/run.sh --repo ./demo-repo --base "$BASE" --head "$HEAD" --out-dir ./demo-out
cat ./demo-out/report.md
```
A good result is a `significant_concerns` verdict with a critical SQL-injection finding in `src/users.ts` and exit 0, but
that is an expected result, not a guarantee: models vary, and the run can end incomplete (exit 2). On the free tier it
takes many minutes because of the 8,000 tokens-per-minute limit. The synthetic source is sent to Groq.

## Known limits
- **Groq free tier**: 8,000 tokens per minute. Three reviewers do not fit even on tiny diffs; use `REVIEW_AGENTS` and
  `REVIEW_TIMEOUT_SCALE`. Larger investigations can hit HTTP 413 or 429 and end incomplete. A paid tier raises the rate
  limits, but it does not by itself stop the conversation from growing with every tool call; bounded history addresses
  that separately, and long investigations still grow slowly.
- **Cross-file bugs are unproven.** Three Case 001 runs (a defect in an unchanged file that violates a contract of the
  changed code) all ended incomplete, so no detection or miss has been established. The SQL-injection demo is a
  same-diff, single-flow bug.
- Pruning has been verified with scripted models only.
- A model that misses a bug yields `approved` for what it examined; the pipeline cannot tell a miss from a clean diff.
- Your source is sent to the hosted model provider (Groq) in every live run, including the synthetic demo repository.
  Send only repositories you are willing to share.

## More detail
`docs/workspace-security.md` (isolation and threat model), `docs/execution-lifecycle.md` (retries, deadlines, step
caps), `docs/DEVELOPMENT_HANDOFF.md` (current state), `tests/integration/README.md` (provider-free scenarios).
