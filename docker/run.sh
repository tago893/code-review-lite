#!/usr/bin/env bash
# Runs one review end to end in containers.
#   docker/run.sh --repo <dir> --base <rev> --head <rev> [--out-dir <dir>] [--keep]
# GROQ_API_KEY must be set in the calling shell; it is passed to the proxy container by name only.
# Exit codes: 0 complete review, 2 incomplete or failed (including a failed prepare step), 64 bad usage.
set -uo pipefail

usage() { echo "usage: docker/run.sh --repo <dir> --base <rev> --head <rev> [--out-dir <dir>] [--keep]" >&2; exit 64; }
repo=""; base=""; head=""; out_dir="./review-out"; keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --base) base="${2:-}"; shift 2 ;;
    --head) head="${2:-}"; shift 2 ;;
    --out-dir) out_dir="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$repo" ] && [ -n "$base" ] && [ -n "$head" ] || usage
[ -n "${GROQ_API_KEY:-}" ] || { echo "GROQ_API_KEY is not set" >&2; exit 64; }
# Two modes, never inferred from the key. STUB_MODE set: a scripted provider on a network with no route out; the proxy
# accepts only the dummy key. STUB_MODE unset: the real provider, which needs CRA_ALLOW_LIVE=1 and UPSTREAM_URL set
# to https://api.groq.com on purpose. The proxy enforces the same rules again (docker/proxy/server.mjs).
if [ -n "${STUB_MODE:-}" ]; then
  export PROXY_MODE=stub
  [ -n "${UPSTREAM_URL:-}" ] || { echo "UPSTREAM_URL is required (stub mode: the stub's address)" >&2; exit 64; }
else
  export PROXY_MODE=live
  [ "${CRA_ALLOW_LIVE:-}" = 1 ] || { echo "live provider calls are not authorized: set CRA_ALLOW_LIVE=1 to allow them" >&2; exit 64; }
  [ -n "${UPSTREAM_URL:-}" ] || { echo "UPSTREAM_URL is required (live mode: https://api.groq.com)" >&2; exit 64; }
  export PROXY_ALLOW_LIVE=1
fi

native() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
here="$(native "$(dirname "$0")")"
export MSYS_NO_PATHCONV=1
export REVIEW_REPO_DIR; REVIEW_REPO_DIR="$(native "$repo")"
export REVIEW_BASE="$base" REVIEW_HEAD="$head"
project="${CRL_PROJECT:-crl}"
[ -n "${STUB_MODE:-}" ] && export COMPOSE_PROFILES=stub
# CRL_COMPOSE_EXTRA: an extra compose file, for tests only (see tests/integration/compose.mcpdown.yml).
files=(-f "$here/compose.yml")
[ -n "${STUB_MODE:-}" ] && files+=(-f "$here/compose.offline.yml")
[ -n "${CRL_COMPOSE_EXTRA:-}" ] && files+=(-f "$CRL_COMPOSE_EXTRA")
compose() { docker compose -p "$project" "${files[@]}" "$@"; }

mkdir -p "$out_dir"
out_dir="$(native "$out_dir")"
compose down -v --remove-orphans >/dev/null 2>&1
cleanup() { [ "$keep" = 1 ] || compose down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

compose build --quiet || { echo "build failed" >&2; exit 2; }
compose up -d proxy >/dev/null || { echo "proxy failed to start" >&2; exit 2; }
[ -n "${STUB_MODE:-}" ] && { compose up -d stub >/dev/null || { echo "stub failed to start" >&2; exit 2; }; }

# Trusted preparation. If it fails the agent is never started.
if ! compose run --rm --no-deps prep; then
  echo "prepare step failed; the agent was not started" >&2
  exit 2
fi

compose run --no-deps --name "$project-agent" agent >"$out_dir/stdout.txt" 2>"$out_dir/stderr.txt"
rc=$?
docker cp "$project-agent:/review/out/." "$out_dir/" >/dev/null 2>&1
docker logs "$project-proxy-1" >"$out_dir/proxy.log" 2>&1
[ -n "${STUB_MODE:-}" ] && docker logs "$project-stub-1" >"$out_dir/stub.log" 2>&1
docker cp "$project-proxy-1:/logs/requests.jsonl" "$out_dir/requests.jsonl" >/dev/null 2>&1
[ "$keep" = 1 ] || docker rm -f "$project-agent" >/dev/null 2>&1

cat "$out_dir/stdout.txt"
exit "$rc"
