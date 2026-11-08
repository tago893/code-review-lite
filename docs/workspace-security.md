# Secure reviewer workspace (Task 4B)

The OpenCode agent never sees the raw checkout. A trusted prep container reads it and builds a sanitised
snapshot; the agent container mounts only that snapshot, read-only.

```
raw checkout ──(ro mount)──> prep (no network, no key) ──writes──> repo_ws, ctx_ws
                                                                     │ (ro mounts)
                                                              agent: /repo, /review/context
```

## What enforces the boundary
- **Mounts.** The agent container has no mount of the raw volume, no `.git`, and a read-only `/repo` and
  `/review/context`. The enforcement is the kernel and Docker, not the model and not OpenCode's permissions.
- **Prep.** `src/workspace/prepare.ts` copies only regular UTF-8 text files, opens them with `O_NOFOLLOW`, never
  follows links, and writes with `wx` under a path checked to stay inside the output. It leaves out symlinks, fifos
  and devices, binary and non-UTF-8 files, files over 1 MB, `.git`/`.hg`/`.svn`/`node_modules`/`.ssh`/`.aws`, env
  files (templates such as `.env.example` are kept), key and credential files, and names with control characters or
  secrets in them. Redaction keeps every line (`src/safety`), and a second pass must change nothing.
- **Failure.** Any error clears the output and returns a fixed error code. The `READY` marker is written last, and
  compose does not start the agent unless prep exits 0.
- **Diff.** `src/workspace/context.ts` redacts the diff and withholds the content of sensitive files, listing only
  their paths. `gateForModel` (`src/workspace/gate.ts`) is the single crossing for Phase 1 context and for
  investigation notes before Phase 2; a failure returns `incomplete`.
- **Permissions.** `reviewerPermission()` denies everything except read, grep, glob and list. It is a second layer.

## Checks
- `bash scripts/test-in-docker.sh` — typecheck and unit tests on Node 22.
- `bash scripts/test-workspace-boundary.sh` — Docker checks run inside the agent container with synthetic secrets,
  including a control run that must fail when the raw volume is mounted.

## Residual limitations
- Redaction is pattern-based. It misses all-letter passwords, secrets inside URLs that contain `@` or `/`, short or
  unprefixed tokens, encoded secrets and secrets split across lines. A repository can contain a secret we do not
  recognise, and it will reach the model. Use only approved or synthetic repositories with hosted models.
- Source code that is not a secret but is sensitive (proprietary logic) is still sent to the hosted model.
- Skipped symlinks, binaries and oversized files are invisible to the reviewer; the manifest lists them.
- The Phase 1 notes gate and the reporting path are wired in later tasks; `gateForModel` exists but nothing calls it yet.
- The boundary checks run against a probe in the agent image, not against the OpenCode process; the real runner,
  proxy and permissions are joined to this compose file in a later task.
- `scripts/probe-boundary.sh` is bind-mounted into the test run; that is a test-only mount.

## End-to-end sandbox (Task 10)
`docker/run.sh --repo <dir> --base <rev> --head <rev>` runs `prepare` (no network, no key), then `review` in an agent
container on an `internal: true` network whose only peer is `proxy`. `proxy` is the only holder of `GROQ_API_KEY`
(passed by name), forwards only `POST /openai/v1/chat/completions` and `GET /openai/v1/models`, and discards inbound
Authorization. All three containers are non-root-capable, read-only, `cap_drop: ALL`, `no-new-privileges`, with
memory, CPU and PID limits.

Checks (real containers, real OpenCode 1.19.5):
- `tests/integration/probe-agent.sh` (22 OS-level checks: user, read-only mounts, no socket or raw mount, no key, no egress).
- `tests/integration/run-integration.sh <dir>`: scripted-model scenarios `attack`, `obey`, `report`, `error`.
- One live Groq run on the synthetic repo with a seeded SQL injection.

Known limits:
- `REVIEW_AGENTS` narrows a run and the report says so; `REVIEW_TIMEOUT_SCALE` (1 to 10) lengthens timeouts. Both exist
  because the 8,000 tokens-per-minute tier cannot finish three reviewers on even a tiny diff.
- A model that obeys an injection and reports nothing yields `approved`; the pipeline cannot tell a missed bug from a clean diff.
- File access is a small trusted MCP server (`src/mcp`), registered inline by CRA and started as a child process in the
  agent container. The model is offered exactly `cra_read`, `cra_grep`, `cra_glob`, `cra_list` (asserted by the `attack`
  scenario from the tool names in each request); OpenCode's built-in read/grep/glob/list and every other built-in are
  denied. The server reads only under `/repo` and `/review/context`, rejects `..`, absolute escapes, NUL bytes and every
  symlink (a path must equal its own realpath), re-applies the snapshot's withheld-name rules, caps lines, bytes,
  matches and search time, and marks every truncation with the offset to continue from. It never executes repository
  content (searches are ripgrep with a fixed argument vector). If it is not connected at startup, or OpenCode registers
  any MCP server or tool CRA did not expect, the review ends incomplete (`model_tooling`, exit 2) and there is no
  fall back to the built-ins. The mounts remain the primary boundary.
- OpenCode runs in a fresh empty working directory with `OPENCODE_DISABLE_PROJECT_CONFIG=1`; the snapshot also excludes
  `.opencode/`, `opencode.json` and `opencode.jsonc`. Measured with 1.19.5: the environment variable alone does NOT stop
  `.opencode/plugin/*.js` from running, so the working directory is what protects. The `hostile` scenario proves the
  protection and that its control (project config on) is compromised.
- Docker Desktop on Windows was the only platform tested. `internal: true` blocked all egress there.
