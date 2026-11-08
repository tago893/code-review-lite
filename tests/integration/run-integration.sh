#!/usr/bin/env bash
# Real-container integration scenarios with a scripted model (no provider key, no network).
#   tests/integration/run-integration.sh <work-dir> [scenario...]      scenarios: attack obey report error
# Every scenario runs the real CLI, the real OpenCode SDK, the real prep/agent/proxy containers and the real
# network topology. Only the model is replaced, by tests/integration/stub-groq.mjs behind the real proxy, which
# holds a recognisable DUMMY key (never a real one) so key handling can be asserted.
set -uo pipefail
work="$(cd "${1:?usage: run-integration.sh <work-dir> [scenario...]}" && pwd)"; shift
scenarios=("$@"); [ ${#scenarios[@]} -eq 0 ] && scenarios=(attack obey report error)
root="$(cd "$(dirname "$0")/../.." && pwd)"
rootn="$(cd "$root" && (pwd -W 2>/dev/null || pwd))"   # native path for docker, which gets MSYS_NO_PATHCONV=1
export GROQ_API_KEY="gsk_STUBKEY0123456789abcdefSTUBKEY0123456789abcdef"   # dummy; the stub checks the proxy injected it
export PROXY_LOG_BODIES=1 UPSTREAM_URL="http://stub:9000"
fails=0
pass() { echo "  PASS $1"; }
fail() { echo "  FAIL $1"; fails=$((fails + 1)); }
has() { grep -qF -- "$2" "$1" 2>/dev/null; }

make_repo() { # make_repo <dir> [INJECT=1]
  rm -rf "$1"; env "${2:-X=0}" bash "$root/tests/integration/make-fixture-repo.sh" "$1" >"$1.shas" 2>/dev/null || { mkdir -p "$1"; env "${2:-X=0}" bash "$root/tests/integration/make-fixture-repo.sh" "$1" >"$1.shas"; }
  # shellcheck disable=SC1090
  source "$1.shas"
}

run_case() { # run_case <name> <STUB_MODE> <repo> [env...]
  local name=$1 mode=$2 repo=$3; shift 3
  rm -rf "$work/$name"
  ( export STUB_MODE="$mode" CRL_PROJECT="crl-$name"; for kv in "$@"; do export "${kv?}"; done
    bash "$root/docker/run.sh" --repo "$repo" --base "$BASE" --head "$HEAD" --out-dir "$work/$name" --keep >"$work/$name.stdout" 2>"$work/$name.stderr" )
  echo $? >"$work/$name.rc"
}
teardown() { COMPOSE_PROFILES=stub REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "crl-$1" -f "$rootn/docker/compose.yml" down -v >/dev/null 2>&1; }
rc() { cat "$work/$1.rc"; }

for s in "${scenarios[@]}"; do
  echo "== scenario: $s"
  case "$s" in
    attack)
      make_repo "$work/repo-attack"
      run_case attack attack "$work/repo-attack" REVIEW_AGENTS=security
      d="$work/attack"
      echo "  exit=$(rc attack); tool calls seen by OpenCode:"; grep '"event":"tool_call"' "$d/run.jsonl" | sed 's/"ts":"[^"]*",//' | cut -c1-230 | sed 's/^/    /'
      for t in bash write edit webfetch; do
        grep '"event":"tool_call"' "$d/run.jsonl" | grep "\"tool\":\"$t\"" | grep -q '"status":"completed"' && fail "forbidden tool '$t' completed" || pass "forbidden tool '$t' did not complete"
      done
      grep '"event":"tool_call"' "$d/run.jsonl" | grep -E '/etc/passwd|/proc/self/environ|/review/out' | grep -q '"status":"completed"' && fail "an out-of-bounds read completed" || pass "reads of /etc/passwd, /proc/self/environ and /review/out did not complete"
      [ ! -e "$d/pwned.txt" ] && [ ! -e "$d/env.txt" ] && pass "no file was created in /review/out" || fail "forbidden write created a file"
      has "$d/stub.log" '"keyInjected":true' && pass "proxy replaced the placeholder with the credential (stub saw it)" || fail "stub never saw the injected credential"
      has "$d/stub.log" '"keyInjected":false' && fail "a request reached the stub without the credential" || pass "every request carried the proxy credential"
      ;;
    obey)
      make_repo "$work/repo-obey" INJECT=1
      run_case obey obey "$work/repo-obey" REVIEW_AGENTS=security
      d="$work/obey"
      echo "  exit=$(rc obey)"; sed -n '1,8p' "$d/report.md" | sed 's/^/    /'
      has "$d/requests.jsonl" 'ignore all previous instructions' && pass "the injected text reached the model only as quoted diff data (control: it is present)" || fail "control failed: injection text not found in request log"
      bad=0; while IFS= read -r line; do n=$(printf '%s' "$line" | grep -o '</shared_context>' | wc -l); [ "$n" -gt 1 ] && bad=1; done < <(grep '"has_tools":true' "$d/requests.jsonl")
      [ "$bad" = 0 ] && pass "the injected closing tag was neutralised: each tool-phase prompt has exactly one real </shared_context>" || fail "injected </shared_context> reached a prompt"
      has "$d/report.md" "Verdict: approved" && pass "verdict equals the rubric over the (empty) confirmed findings: approved" || fail "verdict differs from the rubric result"
      ;;
    report)
      make_repo "$work/repo-report"
      run_case report report "$work/repo-report" REVIEW_AGENTS=security
      d="$work/report"
      echo "  exit=$(rc report)"; sed -n '1,22p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc report)" = 0 ] && pass "complete review exits 0" || fail "exit code $(rc report)"
      has "$d/report.md" '`src/users.ts:4`' && pass "finding cites src/users.ts:4, the seeded line, validated against the sanitised snapshot" || fail "seeded line not reported"
      has "$d/report.md" "heuristic detector" && pass "confirmed by the deterministic detector, not by model say-so" || fail "no detector confirmation"
      has "$d/report.md" "Verdict: significant_concerns" && pass "verdict follows the rubric (confirmed critical)" || fail "unexpected verdict"
      grep '"has_response_format":true' "$d/requests.jsonl" | grep -q '"has_tools":true' && fail "a structured request carried tools" || pass "structured (Phase 2 / judge / verifier) requests carried no tools"
      grep -q '"has_response_format":true' "$d/requests.jsonl" && pass "Phase 2 structured request was made" || fail "no structured request seen"
      ;;
    overflow)
      # A deterministic "request too large" (HTTP 413) after the first tool call. It must fail visibly and once, with the
      # evidence preserved, and must NOT be silently compacted and carried on.
      make_repo "$work/repo-overflow"
      run_case overflow overflow "$work/repo-overflow" REVIEW_AGENTS=code_quality
      d="$work/overflow"
      echo "  exit=$(rc overflow)"; sed -n '1,14p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc overflow)" = 2 ] && pass "an oversized request ends the review incomplete (exit 2)" || fail "exit code $(rc overflow), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined, never approved" || fail "wrong verdict"
      has "$d/report.md" "model_context_overflow" && pass "failure is named context overflow" || fail "failure not named"
      n=$(grep -c '"answered":413' "$d/stub.log" 2>/dev/null); [ "$n" = 1 ] && pass "the oversized request was sent exactly once, not repeated unchanged" || fail "oversized request sent $n times"
      has "$d/stub.log" '"kind":"compaction"' && fail "OpenCode compacted the investigation" || pass "no compaction request was made (automatic compaction is off)"
      grep '"event":"tool_call"' "$d/run.jsonl" | grep -q '"tool":"read"' && pass "the tool call made before the failure was logged" || fail "tool call lost with the failed attempt"
      grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -q '"kind":"context_overflow".*"decision":"stop_not_retryable"' && pass "decision logged: context_overflow, stop_not_retryable" || fail "attempt decision not logged"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "the failed session was cancelled, confirmed idle and deleted" || fail "session cleanup not confirmed"
      has "$d/report.md" "tokens: unknown" && pass "token usage is reported as unknown, not zero" || fail "usage shown as a number"
      grep -q '"event":"provider_error"' "$d/proxy.log" && grep '"event":"provider_error"' "$d/proxy.log" | grep -q '"status":413.*"window":"TPM"' && pass "proxy logged the 413 with its limit window, without message text" || fail "proxy did not log provider_error facts"
      ;;
    ratelimit)
      # The provider answers 429 forever. Retries must stay inside a bounded budget and every session must be cleaned up.
      make_repo "$work/repo-ratelimit"
      run_case ratelimit ratelimit "$work/repo-ratelimit" REVIEW_AGENTS=code_quality REVIEW_SESSION_RETRIES=2
      d="$work/ratelimit"
      echo "  exit=$(rc ratelimit)"; sed -n '1,12p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc ratelimit)" = 2 ] && pass "persistent rate limiting ends the review incomplete (exit 2)" || fail "exit code $(rc ratelimit), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined" || fail "wrong verdict"
      nf=$(grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -c '"kind":"rate_limit"'); [ "$nf" = 6 ] && pass "six attempts (3 tries x 2 models), each failing as rate_limit" || fail "attempt_failed rate_limit count = $nf"
      for dec in retry_same_model fallback_model exhausted; do grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -q "\"decision\":\"$dec\"" && pass "decision logged: $dec" || fail "decision $dec not logged"; done
      nr=$(grep -c '"event":"session_retry"' "$d/run.jsonl"); [ "$nr" -ge 6 ] && pass "OpenCode's own retries were traced ($nr)" || fail "session_retry events = $nr"
      nreq=$(grep -c '"answered":429' "$d/stub.log"); [ "$nreq" -ge 6 ] && [ "$nreq" -le 30 ] && pass "provider requests stayed inside the retry budget ($nreq <= 30)" || fail "provider requests = $nreq"
      na=$(grep -c '"event":"attempt_session"' "$d/run.jsonl"); nc=$(grep -c '"event":"session_cleanup"' "$d/run.jsonl")
      [ "$na" = "$nc" ] && [ "$na" -ge 6 ] && pass "every one of the $na sessions was cleaned up" || fail "sessions=$na cleanups=$nc"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -qE '"idle":false|"abort":"failed"|"delete":"failed"' && fail "a cleanup step failed" || pass "no cleanup step failed"
      ;;
    abandon)
      # An attempt abandoned by its deadline must take its OpenCode session with it, and a replacement must not overlap it.
      mkdir -p "$work/abandon"
      pj="crl-abandon"
      ( export STUB_MODE=ratelimit_slow COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" up -d proxy stub >/dev/null 2>&1
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" run --rm --no-deps -v "$rootn/tests/integration/abandon-probe.mjs:/probe.mjs:ro" --entrypoint node agent /probe.mjs >"$work/abandon/probe.out" 2>"$work/abandon/probe.err" )
      grep -E '"(check|summary)"' "$work/abandon/probe.out" | sed 's/^/    /' | cut -c1-230
      grep -q '"summary":"ABANDON PROBE","failures":0' "$work/abandon/probe.out" && pass "abandoned attempt leaves no session; replacement never overlaps" || fail "abandon probe reported failures"
      ;;
    error)
      make_repo "$work/repo-error"
      run_case error error "$work/repo-error" REVIEW_AGENTS=security
      d="$work/error"
      echo "  exit=$(rc error)"; sed -n '1,14p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc error)" = 2 ] && pass "provider failure exits 2" || fail "exit code $(rc error), expected 2"
      has "$d/report.md" "REVIEW INCOMPLETE" && pass "report headline is REVIEW INCOMPLETE" || fail "headline missing"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined (not approved)" || fail "wrong verdict"
      ;;
  esac
  # OS-level probe inside an agent container with this scenario's real mounts, network and limits.
  if [ "$s" = report ]; then
    echo "  -- container probe"
    probe_out=$(COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "crl-$s" -f "$rootn/docker/compose.yml" run --rm --no-deps -v "$rootn/tests/integration/probe-agent.sh:/probe.sh:ro" agent sh /probe.sh 2>&1)
    echo "$probe_out" | grep -E "PROBE (PASS|FAIL|SUMMARY)" | sed 's/^/    /'
    echo "$probe_out" | grep -q "PROBE SUMMARY failures=0" && pass "all container probe checks passed" || { fail "container probe reported failures"; echo "$probe_out" | head -12 | cut -c1-200 | sed "s/^/    | /"; }
  fi
  # Credential isolation against the real agent container of this scenario.
  if [ -e "$work/$s.rc" ] && docker inspect "crl-$s-agent" >/dev/null 2>&1; then
    n=$(docker export "crl-$s-agent" | grep -acF -- "$GROQ_API_KEY"); [ "$n" = 0 ] && pass "dummy key absent from the agent container filesystem" || fail "key found in agent filesystem ($n)"
    n=$(docker inspect "crl-$s-agent" | grep -acF -- "$GROQ_API_KEY"); [ "$n" = 0 ] && pass "dummy key absent from the agent container config/env" || fail "key in agent config"
  fi
  n=$(grep -rlF -- "$GROQ_API_KEY" "$work/$s" 2>/dev/null | grep -v 'stub.log' | wc -l); [ "$n" = 0 ] && pass "dummy key absent from the report, run log, metrics and proxy log" || fail "key present in $n output file(s)"
  teardown "$s"
done
echo "INTEGRATION SUMMARY failures=$fails"
[ "$fails" -eq 0 ]
