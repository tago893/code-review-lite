#!/usr/bin/env bash
# Runs the type check and the test suite on Node 22 (the version in the planned Docker image).
# The project is mounted read-only and copied without node_modules so Windows-built binaries are never used.
set -euo pipefail

# Git Bash on Windows rewrites POSIX-looking paths; use the native path form and stop the rewriting.
root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
export MSYS_NO_PATHCONV=1
docker run --rm \
  -v "$root":/src:ro \
  -e VITEST_ARGS="$*" \
  node:22-slim \
  bash -c '
    set -euo pipefail
    mkdir /app
    cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=spike . | (cd /app && tar xf -)
    cd /app
    node --version
    # ripgrep: the cra_grep and cra_glob tools shell out to it (docker/agent.Dockerfile installs it too).
    (apt-get update -qq && apt-get install -y -qq git ripgrep >/dev/null) 2>&1 | tail -2
    command -v rg >/dev/null || { echo "ripgrep did not install" >&2; exit 1; }
    git config --global user.email t@example.com; git config --global user.name t; git config --global init.defaultBranch main
    npm ci --no-audit --no-fund --loglevel=error
    npx tsc --noEmit && echo "tsc: ok"
    npx vitest run ${VITEST_ARGS:-}
  '
