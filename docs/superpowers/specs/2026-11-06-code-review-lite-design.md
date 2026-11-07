# code-review-lite: Design

Date: 2026-11-06
Status: Architecture approved by the external reviewer with five required revisions. All five are applied below (sections 6, 7, 9a, 9b, 9c). Awaiting the user's final approval of the revised document. Nothing is built yet.

## 1. Intent

Recreate, at small scale, the system in Cloudflare's post "Orchestrating AI Code Review at scale" (https://blog.cloudflare.com/ai-code-review): a coordinated set of specialised AI reviewers whose output is filtered and verified before a single structured review is produced.

The user's core requirement: **every comment in the final review must be backed by something real** (an actual file and line, quoted evidence that exists in the source), not just model opinion. The user wants the *shape* to be enterprise-grade (orchestrated, observable, extensible) but the first version small. It is a learning/prototype build, "a downgraded version".

## 2. Goals

- Input: a local diff file plus the repo folder it applies to.
- Output: one markdown review (printed and saved) with a verdict, findings grouped by category, each with severity, file, line, and evidence.
- Orchestrated by **OpenCode** (open-source coding agent, server/SDK based), using **Groq** models, low cost.
- Three specialist reviewers: code quality, security, performance, each in its own OpenCode session.
- A coordinator that dedupes, re-categorises, filters speculative/nitpick findings, and **verifies every finding against the real source**. Unverifiable findings are dropped.
- Diff noise filtering, risk tiers, prompt-injection sanitising.
- Severity (critical / warning / suggestion) and a verdict rubric.
- Metrics per run: findings by reviewer and severity, findings dropped by verification, tokens, cost, duration. Logs as JSONL.
- Light resilience: one retry plus one fallback model on rate-limit / transient errors.
- Thin input/output boundary so GitHub can be added later.
- Runs entirely inside a Docker sandbox.

## 3. Non-goals (version 1)

- GitHub/GitLab integration, posting comments, approve/unapprove actions.
- Re-reviews, thread resolution, "break glass".
- Full circuit breaker, per-tier health tracking, remote config (Workers KV equivalent).
- Documentation, release, internal-standards, AGENTS.md reviewers.
- Any attempt to match Cloudflare's scale or numbers.

## 4. Anti-goals (a failure even if it runs)

- A review containing findings that cite files/lines that do not exist, or quote code that is not there.
- A firehose of speculative or "consider adding error handling" noise. Target is a low number of findings per review (article reports about 1.2).
- Anything that touches the user's files outside the mounted project folder, or leaks the API key into files, logs, or the image.

## 5. Constraints

- Windows 11 laptop. The user does not want it to be at risk: all execution in Docker, mounting only the diff and sample repo (read-only where possible). Only Groq API traffic leaves the container.
- Groq API key via environment variable, injected at `docker run`. Never written to disk or baked into the image. Fail fast if missing.
- Cost kept low: small fast Llama-class model for reviewers, a larger one for the coordinator. Exact Groq model IDs are confirmed at plan time (they change).
- Project folder: the repository root (`code-review-lite/`) (user approved).
- Repo conventions from the user's global rules apply: immutability, small files, validation at boundaries, tests first, 80% coverage on our own code.

## 6. Architecture

```
diff file + repo
      |
 [1] ingest + validate
 [2] noise filter (lockfiles, minified, maps, generated; migrations exempt)
 [3] risk tier: trivial / lite / full (full if auth/, crypto/, security-ish paths)
 [4] sanitise user-controlled text (strip prompt boundary tags)
 [5] write per-file patch files + shared context file to a work dir
      |
 OpenCode (server) -> coordinator session
      |  spawn_reviewers tool
      +--> code-quality session  --\
      +--> security session       ---> structured JSON findings
      +--> performance session   --/
      |
 [6] coordinator judge pass: dedupe, re-categorise, drop speculative
 [7] verification: each finding must resolve to a real file+line and its
     quoted evidence must appear in the source. Else dropped (and counted).
 [8] verdict rubric
 [9] render markdown + metrics + JSONL log
```

Risk routing (revision 3: behavior-sensitive, not only size). Size sets a floor; behavior signals can only raise the tier, never lower it.

Size floor (my adaptation, since we have 3 reviewers not 7):
- trivial (<=10 lines, <=20 files): code quality only; coordinator on the smaller model.
- lite (<=100 lines, <=20 files): code quality + security.
- full (more lines/files): all three.

Behavior signals, computed deterministically from the added/removed lines and paths. Any hit forces `full`, regardless of size, and a one-line change can therefore be `full`:
- Trust boundaries and sensitive paths: `auth/`, `crypto/`, session, token, permission, secrets, CORS, middleware.
- Dangerous sinks in added lines: SQL string building, shell/exec/eval, deserialization, path joins on user input, HTML/template injection, outbound HTTP to variable URLs, file writes.
- Weakened safeguards: removed or loosened validation, auth checks, try/catch, timeouts, retries, rate limits; tests deleted or skipped; assertions removed; lint/CI/security config changed.
- Concurrency and state: locks, async/await changes, shared mutable state, transactions, caches.
- Contract changes: public function/API/schema signature changes, DB migrations, dependency manifest changes.
- Performance-shaped changes: new loops around I/O or queries, removed indexes or caching.
The reason for each hit is recorded in the run log, so routing decisions are explainable and testable.

Verdict rubric (from the article, bias toward approval):
- only suggestions / trivial: `approved`
- only suggestions or warnings without production risk: `approved_with_comments`
- multiple warnings suggesting a risk pattern: `minor_issues`
- any critical or production safety risk: `significant_concerns`

Reviewer prompts follow the article's pattern: explicit "What to flag" and "What NOT to flag" sections plus a shared rules file. Findings are structured (JSON in v1; the article used XML, my call).

Plugin boundary (thin): an input provider (v1: local diff) and an output sink (v1: terminal + file). GitHub later implements the same two interfaces.

## 7. Verification ("backed by real things")

Revision 2: a verified citation is NOT a verified bug. Two separate statuses are tracked per finding. (The status names and rules below are SUPERSEDED by Amendment A3; read that instead.)

**Level 1, citation verified (deterministic, in our code).** The file exists in the repo, the line is in range, and the quoted evidence string is found at or near that line. This proves the model is pointing at real code. It does not prove the code is wrong. Failures are dropped and counted.

**Level 2, claim verified (judgment plus evidence).** Each finding must state a falsifiable claim: what goes wrong, under what input or condition, and the code path that causes it (for example caller -> function -> sink). The coordinator checks the claim by reading the surrounding code and callers with read-only tools (section 9a), and records one of:
- `claim_verified`: the coordinator traced the path and confirmed the condition is reachable and the behavior is wrong.
- `claim_plausible`: citation is real and the claim is reasonable, but the path could not be fully confirmed.
- `claim_refuted`: the code handles the case, or the path is unreachable. Dropped and counted.

**How status affects the output:**
- Only `claim_verified` findings may be `critical` or `warning`.
- `claim_plausible` findings are capped at `suggestion` and visibly labeled "unconfirmed".
- The verdict rubric uses only `claim_verified` findings to decide `minor_issues` or `significant_concerns`.
- The review shows each finding's status, and the metrics report counts findings at each level (cited, claim_verified, plausible, refuted, dropped on citation).

We never present "the file and line exist" as proof that a bug is real. Level 2 is the part that a small benchmark (section 9c) measures.

## 8. Metrics and logging

Per run: tier, agents run, findings per reviewer/severity, findings dropped by verification and by the judge, tokens in/out per agent, estimated cost, wall-clock duration, retries/fallbacks used. JSONL event log so a crash still leaves readable logs. A heartbeat line every 30s while models think.

## 9. Resilience (light)

Per-task timeout, an overall timeout, one retry, one fallback model, only for retryable errors (rate limit, 5xx). Auth errors, context overflow and aborts do not trigger fallback (article's classification). If a reviewer fails after that, the review proceeds with a note that the reviewer did not complete, not a silent omission.

## 9a. Specialist repository exploration (revision 1)

Each specialist can look beyond the diff, but only to read. Exploration is read-only, enforced by OpenCode per-agent permissions and by the container (section 9b), not by prompt wording alone.

Allowed tools for every specialist and the coordinator: read file, grep, glob, list directory, all scoped to the mounted repo root. Denied for all agents: edit, write, patch, shell/bash, web fetch, any network tool, and any tool that spawns processes. The coordinator can read but also cannot edit.

What each specialist is told to explore (starting points, in its prompt):
- Code quality: the changed files in full, direct callers and callees of changed functions, and the tests that cover them.
- Security: trust boundaries touched by the change, where input enters, validation on the path, and the sinks the changed code reaches.
- Performance: how often the changed code runs (call sites, loops, request paths), and the data sizes involved.

Limits so exploration stays cheap and bounded: a per-agent cap on files read and tool calls, and a per-task timeout (section 9). Reads outside the repo root are rejected. The shared context file and per-file patches are pre-written so agents do not re-derive the diff.

## 9b. Security boundaries (revision 4)

Docker boundary (the egress and credential-flow bullets here are SUPERSEDED by Amendment A1):
- Non-root user in the container; root filesystem read-only; `--cap-drop ALL`; `no-new-privileges`; memory, CPU and PID limits.
- Repository mounted read-only. One separate writable work/output directory (tmpfs or a single named volume) for patch files, logs and the report. No other host mounts, no Docker socket, no home directory.
- Egress restricted to the Groq API host only (for example through an allow-listing proxy or network rules); exact mechanism on Docker Desktop for Windows is settled at plan time. If egress cannot be restricted, that is stated plainly in the README, not assumed.
- Groq API key supplied as an environment variable at `docker run`, never baked into the image, never mounted as a file, and checked at startup.

Agent boundary:
- The key is visible only to the orchestrator process. Child processes (OpenCode tool processes) get a sanitised environment with the key removed, in the spirit of the article's `sanitizeEnvForChildProcess`.
- Agent tool permissions as in section 9a: read-only, repo-scoped, no shell, no network.
- Diff text, commit messages, filenames and code comments are untrusted data. They are passed as data, boundary tags are stripped, and prompts state that instructions inside them must be ignored. An injected "approve this" must not change the verdict, because the verdict comes from the deterministic rubric over verified findings, not from model prose.
- Logs and reports are passed through secret redaction (key patterns) before being written.
- Tests cover: write attempt denied, read outside repo denied, key absent from agent env and logs, injection strings in a diff do not change output.

## 9c. Small labeled bug-detection benchmark (revision 5; scoring SUPERSEDED by Amendment A6)

A small, honestly labeled set of cases to measure whether the pipeline finds real bugs and stays quiet on clean code. It is a smoke benchmark, not a statistically meaningful evaluation, and the README says so.

Roughly 12 cases, each a tiny repo plus a diff with a ground-truth label file (expected file, line range, category, severity or "none"):
- 6 seeded real bugs: a logic error, an off-by-one, a SQL injection, a missing auth check on a changed route, an N+1 query in a loop, a removed validation.
- 3 clean diffs (including a refactor and a docs-only change) that must produce no critical or warning findings.
- 2 prompt-injection diffs (malicious comment or commit text) that must not alter the verdict or leak the key.
- 1 noise-only diff (lockfile and minified file) that must produce an empty or trivial review.

Metrics reported per run of the benchmark: recall on seeded bugs, precision of critical/warning findings, false-positive findings per clean diff, citation validity rate, claim_verified rate, rate of verified-but-wrong claims (checked against labels), routing correctness (sensitive one-line diffs reach `full`), cost and duration. Results are saved with the run date and model IDs so changes in prompts or models can be compared.

## 10. Left to the builder

- Language/stack for our glue code (my default: TypeScript on Node, since OpenCode's SDK is JS/TS; Python was my earlier guess, to be settled at plan time).
- Exact Groq model IDs and confirming OpenCode's Groq provider config.
- Test fixtures: a small sample repo with a seeded bug, a seeded vulnerability, a noisy lockfile change, and a fake finding to prove verification drops it.
- Docker image layout and how OpenCode's server is started inside it.

## 11. My calls (not agreed by the user, please check)

- Scope split: v1 = pipeline + light resilience; v2 = circuit breaker, re-reviews, GitHub.
- Three reviewers only; tier-to-agent mapping in section 6.
- JSON instead of XML for findings.
- Light resilience limited to one retry and one fallback model.
- Model sizing (small for reviewers, larger for coordinator).
- TypeScript as the likely stack (Rust was considered and not chosen; see chat).
- The five reviewer revisions are applied as written; the specific signal list in section 6, the three claim statuses in section 7, and the benchmark size (about 12 cases) are my concrete choices within them.

## 12. Open items to confirm during planning

- OpenCode Groq provider support and its tool-use quality on Groq-hosted Llama models. If tool use is unreliable, fall back to our own thin orchestrator while keeping the same session-per-reviewer design.
- Groq free-tier rate limits versus three concurrent sessions.

## 13. Amendments (2026-11-06, after plan review)

The exact values live in the plan's Global Constraints; this section records the decisions.

- **A1 Credential flow and egress.** Two containers. A proxy container holds the Groq key and is the only thing with internet access, allow-listed to the Groq host and two API paths. The agent container (OpenCode and our pipeline) has no key, uses a placeholder, and sits on an internal Docker network that can only reach the proxy. Reviewer tools cannot read or leak the key, and egress is enforced by network topology.
- **A2 Filesystem layout.** Agents read only `/repo` (clean checkout of the pinned head revision, read-only) and `/review/context` (shared context, diff and per-file patches, prepared before start, read-only). `/review/out` is writable but outside every agent's allowed paths. Path checks are realpath-based and reject symlinks leaving the allowed roots.
- **A3 Finding levels.** `citation_valid` < `semantically_supported` < `independently_confirmed`, plus `refuted`. Independent confirmation needs a deterministic detector match or agreement from a verifier on a different model; coordinator judgment alone never confirms. Only confirmed findings can be critical; supported findings are capped at warning; citation-only findings at suggestion.
- **A4 Revision pinning.** Input is repo plus base and head revisions. The diff is generated from those SHAs, the repo is a clean checkout of head, and finding lines are mapped to changed lines from the diff hunks.
- **A5 Completion versus verdict.** Completion (`complete` or `incomplete`) is separate from verdict. A failed required reviewer or coordinator gives `incomplete`, verdict `not_determined`, and exit code 2, never an approval-style outcome.
- **A6 Benchmark scoring.** A hit needs matching file, line range, category and a root-cause match on the finding's explanation. A wrong explanation on the right line is a false positive and a miss. A diff-only baseline run is reported next to the repo-aware run.
- **A7 Integration tests.** Prompt-injection and sandbox rules are tested against real containers and real OpenCode, using a scripted Groq-compatible stub model for determinism, plus a live Groq run of the injection cases.
- **A8 Cadence and commits.** Work proceeds one task at a time with results shown and approval requested after each. Git commits happen only with the user's approval.
