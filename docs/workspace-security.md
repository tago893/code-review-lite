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
