# Task 0 spike notes (2026-11-07)

**Status: Task 0 passed. (e) re-run cleanly on 2026-11-07; Task 1 approved by the owner.**

## Decision
`ORCHESTRATOR=opencode`, with **two-phase reviewers**.

- Phase 1 (tools on, structured output off): the reviewer reads and greps through OpenCode and writes plain-text notes.
- Phase 2 (tools off, strict `json_schema`): a separate call turns only those notes into findings. Validate with zod. Reason: Groq documents that Structured Outputs cannot be combined with tool use.

## Models tried
`openai/gpt-oss-20b` (small) and `openai/gpt-oss-120b` (larger). Both passed everything below. Final choice of reviewer vs coordinator model is still open.

## Results
| Check | gpt-oss-20b | gpt-oss-120b |
|---|---|---|
| (a) Reads source via read and grep tools | pass | pass |
| (b) Strict structured output, no tools, 3 runs | pass | pass |
| (c) Forbidden tools denied (write, bash, /etc/passwd, /review/out, symlink, webfetch) | **partially verified**: no leak, 3 of 6 enforced by tooling | **partially verified**: no leak, 2 of 6 enforced by tooling |
| (e) Two-phase explore then structure, 2 runs | **pass** (clean script run) | **pass** (clean script run) |

(d) Credential flow, from inside the agent container: **pass**. Key is not in env, any `/proc/*/environ`, or the filesystem; direct request to `api.groq.com` is blocked (`EAI_AGAIN`); proxy returns 403 for an off-allow-list path and 200 for the model list.

## Caveats (read these)
1. **(c) is partially verified, not proven.** No leak or side effect happened, but the remaining forbidden-tool paths need deterministic enforcement tests later (call the tool directly or force the call, assert the tooling denies it). Model refusal alone is not proof of tool isolation.
1a. **The symlink attempt in (c) tested nothing.** `spike/agent/Dockerfile` removes any symlink whose real target is outside `/repo` before the agent starts, because OpenCode's permission globs match the lexical path, so a symlink inside `/repo` could bypass them. The `/repo/escape -> /etc` link was therefore gone at test time. Symlink handling must be covered by a deterministic test of the prep step and of the realpath check, not by this spike.
2. **(e) clean pass, final assertion.** For each of 2 runs per model: the model read the file with the tool; phase 1 notes kept the path, line, exact code, an Uncertainty line and a Counter-evidence line; phase 2 returned schema-valid JSON citing line 4 or 5; and every phase-2 finding line appears in the phase-1 notes (no invented findings). Earlier failed attempts were harness bugs, not model failures: Groq 429 on phase 2 (fixed with a retry that waits the server-provided delay), a line assertion that only accepted line 5, and a regex that missed the non-breaking hyphen in "Counter-evidence".
3. Only one fixture file and one seeded bug. This shows the mechanism works, not review quality.
4. **Rate limit:** 8,000 tokens per minute on the base plan. Retries must be bounded and honour the server-provided delay; keep reviewer concurrency low.

## Why the original permission pattern failed
The plan used `read` allowed under `/repo/**`. OpenCode matches paths **inside the worktree relative to the worktree root** (we run with cwd `/repo`), so an absolute `/repo/**` pattern never matched anything. Anything **outside** the worktree is gated by `external_directory`, which is therefore the security boundary: deny `*`, allow only `/review/context/**`. Keep this boundary; do not replace it with an absolute-path pattern.

## OpenCode config that denies edit, bash and webfetch
In `agent/spike.mjs` (`permission`): default `"*": "deny"`; `read` allowed except `*.env` and `*.env.*`; `grep`, `glob`, `list` allowed; `edit`, `bash`, `webfetch`, `websearch`, `task`, `todowrite`, `skill`, `question`, `lsp`, `doom_loop` denied; `external_directory` denies everything except `/review/context/**`. In-worktree paths match relative to `/repo`, so the plan's `/repo/**` pattern never matched.
