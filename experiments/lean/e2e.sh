#!/usr/bin/env bash
# Provider-free container check of the lean reviewer: the real prep/proxy/agent containers and docker/run.sh, with the
# scripted stub in place of the provider. No key, no network. Usage: experiments/lean/e2e.sh <work-dir> [scenario...]
# scenarios: report attack long long429 error
set -uo pipefail
work="$(cd "${1:?usage: e2e.sh <work-dir> [scenario...]}" && pwd)"; shift
scen=("$@"); [ ${#scen[@]} -eq 0 ] && scen=(report attack long long429 error)
root="$(cd "$(dirname "$0")/../.." && pwd)"; rootn="$(cd "$root" && (pwd -W 2>/dev/null || pwd))"
export GROQ_API_KEY="gsk_STUBKEY0123456789abcdefSTUBKEY0123456789abcdef" PROXY_LOG_BODIES=1 UPSTREAM_URL="http://stub:9000" PROXY_MODE=stub
fails=0; pass() { echo "  PASS $1"; }; fail() { echo "  FAIL $1"; fails=$((fails + 1)); }
(cd "$root" && npx tsc -p experiments/lean/tsconfig.json) || { echo "tsc failed"; exit 1; }

run() { # run <name> <STUB_MODE> [env...]
  local name=$1 mode=$2; shift 2
  local repo="$work/repo-$name"; rm -rf "$repo" "$work/$name"
  BIGFILE=1 bash "$root/tests/integration/make-fixture-repo.sh" "$repo" >"$repo.shas" 2>/dev/null || { mkdir -p "$repo"; BIGFILE=1 bash "$root/tests/integration/make-fixture-repo.sh" "$repo" >"$repo.shas"; }
  # shellcheck disable=SC1090
  source "$repo.shas"
  ( export STUB_MODE="$mode" CRL_PROJECT="crl-lean-$name" CRL_COMPOSE_EXTRA="$rootn/experiments/lean/compose.lean.yml"; for kv in "$@"; do export "${kv?}"; done
    bash "$root/docker/run.sh" --repo "$repo" --base "$BASE" --head "$HEAD" --out-dir "$work/$name" --keep >"$work/$name.stdout" 2>"$work/$name.stderr" )
  echo $? >"$work/$name.rc"
}
rc() { cat "$work/$1.rc"; }
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
teardown() { COMPOSE_PROFILES=stub REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "crl-lean-$1" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" down -v >/dev/null 2>&1; }
tools() { grep '"event":"tool"' "$work/$1/lean-trace.jsonl" | sed 's/"t":[0-9]*,//' | cut -c1-120 | sed 's/^/    /'; }

for s in "${scen[@]}"; do
  echo "== lean scenario: $s"
  case "$s" in
    report)
      run report report
      d="$work/report"; echo "  exit=$(rc report): $(cat "$work/report.stdout")"
      [ "$(rc report)" = 0 ] && pass "complete review exits 0" || fail "exit $(rc report)"
      has "$d/lean-findings.json" '"line": 4' && has "$d/lean-findings.json" 'src/users.ts' && pass "finding cites src/users.ts:4 and passed the citation check" || fail "seeded finding missing"
      has "$d/lean-trace.jsonl" '"event":"structured"' && pass "separate structured phase ran" || fail "no structured phase"
      has "$d/stub.log" '"keyInjected":false' && fail "a request reached the stub without the credential" || pass "every request carried the proxy credential"
      grep -q "gsk_STUBKEY" "$d"/lean-* "$d/stdout.txt" "$d/stderr.txt" 2>/dev/null && fail "key text found in agent output" || pass "no credential text in the agent's output or trace"
      ;;
    attack)
      run attack attack LEAN_MAX_FORBIDDEN_CALLS=40 PROXY_MAX_REQUESTS=40
      d="$work/attack"; echo "  exit=$(rc attack): $(cat "$work/attack.stdout")"; tools attack
      ok=$(grep '"event":"tool"' "$d/lean-trace.jsonl" | grep -c '"status":"ok"')
      [ "$ok" = 0 ] && pass "every scripted escape was refused (0 of the attack calls succeeded)" || fail "$ok attack call(s) succeeded"
      [ ! -e "$d/pwned.txt" ] && [ ! -e "$d/env.txt" ] && pass "nothing was written to the output directory" || fail "a forbidden write created a file"
      offered=$(grep -o '"toolNames":\[[^]]*\]' "$d/stub.log" | sort -u | paste -sd, -)
      [ "$offered" = '"toolNames":["cra_read","cra_grep","cra_glob","cra_list"]' ] && pass "the model was offered exactly the four cra_* tools" || fail "tool set: $offered"
      ;;
    long|long429)
      extra=(); [ "$s" = long429 ] && extra=(STUB_429_AT=6)
      run "$s" long STUB_CALLS=14 PROXY_MAX_REQUESTS=60 REVIEW_INVESTIGATION_STEPS=20 LEAN_HISTORY_BYTES=8000 "${extra[@]}"
      d="$work/$s"; echo "  exit=$(rc "$s"): $(cat "$work/$s.stdout")"
      sizes=$(grep '"event":"request"' "$d/lean-trace.jsonl" | grep -o '"bytes":[0-9]*' | cut -d: -f2 | paste -sd' ' -)
      echo "    request bytes per turn: $sizes"; echo "    max=$(echo "$sizes" | tr ' ' '\n' | sort -n | tail -1)"
      [ "$(echo "$sizes" | tr ' ' '\n' | sort -n | tail -1)" -le 32000 ] && pass "every request stayed under the 32000-byte budget" || fail "a request exceeded the budget"
      grep -q '"prunedResults":[1-9]' "$d/lean-trace.jsonl" && pass "older tool results were replaced by references" || fail "nothing was pruned"
      [ "$(rc "$s")" = 0 ] && pass "complete" || fail "exit $(rc "$s")"
      if [ "$s" = long429 ]; then
        grep -q '"event":"retried_429"' "$d/lean-trace.jsonl" && pass "the single 429 was retried and the run completed" || fail "no 429 retry recorded"
      fi
      ;;
    error)
      run error error
      d="$work/error"; echo "  exit=$(rc error): $(cat "$work/error.stdout")"
      [ "$(rc error)" = 2 ] && pass "provider failure exits 2 (incomplete)" || fail "exit $(rc error)"
      has "$d/lean-findings.json" 'provider_500' && pass "the provider status is in the result" || fail "status missing"
      [ "$(grep -c '"answered":500' "$d/stub.log")" = 1 ] && pass "a 500 was not retried" || fail "500 was retried"
      ;;
  esac
  teardown "$s"
done
echo; [ "$fails" = 0 ] && echo "all lean checks passed" || echo "$fails check(s) failed"
exit "$fails"
