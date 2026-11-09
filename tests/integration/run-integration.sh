#!/usr/bin/env bash
# Real-container integration scenarios with a scripted model (no provider key, no network).
#   tests/integration/run-integration.sh <work-dir> [scenario...]      scenarios: attack obey report error overflow ratelimit abandon deadline stepcap stepcap_stubborn hostile mcpdown budget budget_stubborn offline workload history history_long history_guard history_broken
# Every scenario runs the real CLI, the real OpenCode SDK, the real prep/agent/proxy containers and the real
# network topology. Only the model is replaced, by tests/integration/stub-groq.mjs behind the real proxy, which
# holds a recognisable DUMMY key (never a real one) so key handling can be asserted.
set -uo pipefail
work="$(cd "${1:?usage: run-integration.sh <work-dir> [scenario...]}" && pwd)"; shift
scenarios=("$@"); [ ${#scenarios[@]} -eq 0 ] && scenarios=(attack obey report error)
root="$(cd "$(dirname "$0")/../.." && pwd)"
rootn="$(cd "$root" && (pwd -W 2>/dev/null || pwd))"   # native path for docker, which gets MSYS_NO_PATHCONV=1
export GROQ_API_KEY="gsk_STUBKEY0123456789abcdefSTUBKEY0123456789abcdef"   # dummy; the stub checks the proxy injected it
export PROXY_LOG_BODIES=1 UPSTREAM_URL="http://stub:9000" PROXY_MODE=stub
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
teardown() { COMPOSE_PROFILES=stub REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "crl-$1" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" down -v >/dev/null 2>&1; }
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
      # The model is offered exactly the four bounded MCP tools, never a built-in; every escape through them is refused.
      offered=$(grep -o '"toolNames":\[[^]]*\]' "$d/stub.log" | sort -u | paste -sd, -)
      [ "$offered" = '"toolNames":["cra_glob","cra_grep","cra_list","cra_read"]' ] && pass "the model was offered exactly cra_glob, cra_grep, cra_list, cra_read" || fail "unexpected tool set offered: $offered"
      escapes=$(grep '"event":"tool_call"' "$d/run.jsonl" | grep '"tool":"cra_' | grep -vc '"status":"error"')
      [ "$escapes" = 0 ] && pass "every out-of-bounds cra_* call (absolute, traversal, /proc, /review/out, /etc, /) was refused" || fail "$escapes out-of-bounds cra_* call(s) were not refused"
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
      ir=$(cd "$d" && node "$rootn/tests/integration/inspect-requests.mjs" requests.jsonl)
      echo "$ir" | grep -q '"anyHasInvestigatorPrompt":false' && echo "$ir" | grep -q '"anyHasTools":false' && pass "structured requests do not carry the investigator prompt or tools" || fail "structured requests were affected"
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
      grep '"event":"tool_call"' "$d/run.jsonl" | grep -q '"tool":"cra_read"' && pass "the tool call made before the failure was logged" || fail "tool call lost with the failed attempt"
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
    deadline)
      # A hard run deadline (1 minute) hits while the provider is still answering 429: the active session must be cancelled and
      # cleaned up, no second attempt or fallback may start, and the review must end incomplete with exit 2.
      make_repo "$work/repo-deadline"
      run_case deadline ratelimit_slow "$work/repo-deadline" REVIEW_AGENTS=code_quality REVIEW_SESSION_RETRIES=20 REVIEW_DEADLINE_MINUTES=1
      d="$work/deadline"
      echo "  exit=$(rc deadline)"; sed -n '1,12p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc deadline)" = 2 ] && pass "deadline ends the review with exit 2" || fail "exit code $(rc deadline), expected 2"
      has "$d/report.md" "REVIEW INCOMPLETE" && has "$d/report.md" "Verdict: not_determined" && pass "REVIEW INCOMPLETE, not_determined" || fail "wrong status/verdict"
      has "$d/report.md" "run_deadline_exceeded" && pass "reason run_deadline_exceeded reported" || fail "deadline reason missing"
      last=$(grep '"event":"attempt_failed"' "$d/run.jsonl" | tail -1)
      case "$last" in *'"kind":"abort"'*'"decision":"stop_not_retryable"'*) pass "the attempt running at the deadline failed as a non-retryable abort (no retry, no fallback)";; *) fail "last attempt_failed: $last";; esac
      [ "$(grep '"event":"reviewer_failed"' "$d/run.jsonl" | grep -c '"kind":"abort"')" = 1 ] && pass "reviewer ended on the abort" || fail "reviewer_failed abort count"
      na=$(grep -c '"event":"attempt_session"' "$d/run.jsonl"); nc=$(grep -c '"event":"session_cleanup"' "$d/run.jsonl")
      [ "$na" -ge 1 ] && [ "$na" = "$nc" ] && [ "$na" = "$(grep -c '"event":"attempt_start"' "$d/run.jsonl")" ] && pass "all $na session(s) cleaned up, none started after the deadline" || fail "sessions=$na cleanups=$nc"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -qE '"idle":false|"abort":"failed"|"delete":"failed"' && fail "a cleanup step failed" || pass "no cleanup step failed"
      ;;
    abandon)
      # An attempt abandoned by its deadline must take its OpenCode session with it, and a replacement must not overlap it.
      mkdir -p "$work/abandon"
      pj="crl-abandon"
      ( export STUB_MODE=ratelimit_slow COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" build --quiet agent >/dev/null 2>&1   # never run a stale image
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" up -d proxy stub >/dev/null 2>&1
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" run --rm --no-deps -v "$rootn/tests/integration/abandon-probe.mjs:/probe.mjs:ro" --entrypoint node agent /probe.mjs >"$work/abandon/probe.out" 2>"$work/abandon/probe.err" )
      grep -E '"(check|summary)"' "$work/abandon/probe.out" | sed 's/^/    /' | cut -c1-230
      grep -q '"summary":"ABANDON PROBE","failures":0' "$work/abandon/probe.out" && pass "abandoned attempt leaves no session; replacement never overlaps" || fail "abandon probe reported failures"
      ;;
    stepcap)
      # An investigation that would never stop on its own, under a 3-step cap and a model that obeys OpenCode's
      # "respond with text only" instruction on the last step.
      make_repo "$work/repo-stepcap"
      run_case stepcap loop "$work/repo-stepcap" REVIEW_AGENTS=code_quality REVIEW_INVESTIGATION_STEPS=3
      d="$work/stepcap"
      echo "  exit=$(rc stepcap)"; sed -n '1,14p' "$d/report.md" | sed 's/^/    /'
      nt=$(grep -c '"kind":"loop_tool"' "$d/stub.log"); nf=$(grep -c '"kind":"loop_final"' "$d/stub.log")
      [ "$nt" = 2 ] && [ "$nf" = 1 ] && pass "the cap limited the investigation to 3 model calls (2 with tool calls, then the forced final one)" || fail "investigation made $nt tool-turn and $nf final requests, expected 2 and 1"
      grep '"kind":"loop_final"' "$d/stub.log" | grep -q '"told":true' && pass "the last step was the one where OpenCode told the model to answer with text only" || fail "final request was not the instructed last step"
      grep '"event":"investigation_steps"' "$d/run.jsonl" | grep -q '"steps":3.*"stepLimit":3.*"limitReached":true.*"outcome":"finished"' && pass "telemetry records steps=3, stepLimit=3, limitReached=true" || fail "investigation_steps telemetry missing or wrong"
      [ "$(rc stepcap)" = 2 ] && pass "a capped investigation ends the review incomplete (exit 2)" || fail "exit code $(rc stepcap), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined, not a clean approval" || fail "wrong verdict"
      has "$d/report.md" "investigation_truncated" && pass "the report names the reason: investigation_truncated" || fail "reason missing from the report"
      grep '"event":"tool_call"' "$d/run.jsonl" | grep 'src/server.ts' | grep -q '"status":"completed"' && pass "the capped investigation could still read an unchanged file (src/server.ts)" || fail "unchanged file was not readable"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "the session was cancelled, confirmed idle and deleted" || fail "session cleanup not confirmed"
      ir=$(cd "$d" && node "$rootn/tests/integration/inspect-requests.mjs" requests.jsonl); echo "    investigator request: $(echo "$ir" | cut -c1-330)"
      echo "$ir" | grep -q '"systemIsInvestigatorPrompt":true' && echo "$ir" | grep -q '"systemIsOpenCodeBuiltin":false' && pass "the investigator prompt replaced OpenCode's built-in system prompt" || fail "system prompt not replaced"
      echo "$ir" | grep -q '"userHasReviewerRules":true' && echo "$ir" | grep -q '"userHasPrContext":true' && pass "the CRA reviewer instructions and PR context are still in the request" || fail "reviewer rules or PR context missing"
      echo "$ir" | grep -qF '"toolNames":["cra_glob","cra_grep","cra_list","cra_read"]' && pass "the model is still offered exactly the four cra_* tools" || fail "tool set changed"
      ;;
    stepcap_stubborn)
      # Same, but the model ignores the instruction and keeps asking for tools. OpenCode alone would let it run on; the
      # driver must end the attempt, record it, and not call the review clean.
      make_repo "$work/repo-stubborn"
      run_case stepcap_stubborn loop_stubborn "$work/repo-stubborn" REVIEW_AGENTS=code_quality REVIEW_INVESTIGATION_STEPS=3
      d="$work/stepcap_stubborn"
      echo "  exit=$(rc stepcap_stubborn)"; sed -n '1,14p' "$d/report.md" | sed 's/^/    /'
      nt=$(grep -c '"kind":"loop_tool"' "$d/stub.log")
      [ "$nt" -ge 3 ] && [ "$nt" -le 6 ] && pass "a model that ignored the cap was stopped after $nt tool-turn requests (limit 3, at most one poll interval of overshoot)" || fail "tool-turn requests = $nt, expected 3..6"
      grep '"event":"investigation_steps"' "$d/run.jsonl" | grep -q '"stepLimit":3.*"limitReached":true.*"outcome":"overrun"' && pass "telemetry records outcome=overrun with limitReached=true" || fail "overrun telemetry missing"
      grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -q '"kind":"step_limit".*"decision":"stop_not_retryable"' && pass "decision logged: step_limit, stop_not_retryable" || fail "attempt decision not logged"
      na=$(grep -c '"event":"attempt_start"' "$d/run.jsonl"); [ "$na" = 1 ] && pass "no retry or fallback re-ran the same investigation" || fail "attempts = $na"
      [ "$(rc stepcap_stubborn)" = 2 ] && pass "exit 2" || fail "exit code $(rc stepcap_stubborn), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined" || fail "wrong verdict"
      has "$d/report.md" "model_step_limit" && pass "failure is named step limit" || fail "failure not named"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "the session was cancelled, confirmed idle and deleted" || fail "session cleanup not confirmed"
      ;;
    offline)
      # Provider-free tests must be unable to spend real tokens, even by mistake.
      # (a) No live authorization: run.sh refuses before starting anything.
      ( unset STUB_MODE; export CRL_PROJECT=crl-offline-a; bash "$root/docker/run.sh" --repo . --base x --head y --out-dir "$work/offline-a" >"$work/offline-a.out" 2>&1 ); rc_a=$?
      [ "$rc_a" = 64 ] && grep -q "not authorized" "$work/offline-a.out" && pass "live mode without CRA_ALLOW_LIVE=1 is refused (exit 64)" || fail "live mode without authorization was not refused (rc=$rc_a)"
      docker ps -a --format '{{.Names}}' | grep -q '^crl-offline-a' && fail "containers were started" || pass "no container was started"
      # (b) The accidental-live-call scenario: stub mode, but the shell holds a REAL-looking key and Groq as upstream.
      make_repo "$work/repo-offline"
      REALISH="gsk_RealLookingKey0123456789abcdefghijklmnop"
      ( export STUB_MODE=report CRL_PROJECT=crl-offline-b GROQ_API_KEY="$REALISH" UPSTREAM_URL="https://api.groq.com" REVIEW_AGENTS=security
        bash "$root/docker/run.sh" --repo "$work/repo-offline" --base "$BASE" --head "$HEAD" --out-dir "$work/offline-b" --keep >"$work/offline-b.out" 2>"$work/offline-b.err" ); rc_b=$?
      [ "$rc_b" != 0 ] && pass "stub mode with a real-looking key and the Groq upstream did not produce a review (exit $rc_b)" || fail "the review ran"
      grep -q "FATAL: stub mode accepts only the dummy test key" "$work/offline-b/proxy.log" && pass "the proxy refused to start with a real credential in stub mode" || fail "proxy did not refuse the credential"
      [ "$(grep -c '"event":"request"' "$work/offline-b/stub.log" 2>/dev/null || true)" = 0 ] && pass "the stub saw no request" || fail "a request reached the stub"
      grep -rqF -- "$REALISH" "$work/offline-b" && fail "the credential appears in the outputs" || pass "the credential appears in no output"
      # (c) Even a correctly configured stub-mode proxy has no route to the internet.
      ( export STUB_MODE=obey CRL_PROJECT=crl-offline-c; export COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y
        docker compose -p crl-offline-c -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" up -d proxy stub >/dev/null 2>&1
        docker compose -p crl-offline-c -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" exec -T proxy node -e '
          const t = (u) => fetch(u, { signal: AbortSignal.timeout(6000) }).then(() => "REACHED " + u, (e) => "blocked " + u + " " + (e.cause?.code ?? e.name));
          Promise.all([t("https://api.groq.com/openai/v1/models"), t("https://example.com"), t("http://1.1.1.1")]).then((r) => console.log(r.join(" | ")));' >"$work/offline-c.out" 2>&1
        docker compose -p crl-offline-c -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" down -v >/dev/null 2>&1 )
      cat "$work/offline-c.out" | sed 's/^/    /'
      [ "$(grep -o 'blocked' "$work/offline-c.out" | wc -l)" = 3 ] && ! grep -q REACHED "$work/offline-c.out" && pass "the proxy in stub mode cannot reach api.groq.com, example.com or a raw IP" || fail "an external host was reachable from the stub-mode proxy"
      teardown offline-b
      ;;
    workload)
      # The scripted bounded-reading workload through the real pipeline: page through a 700-line unchanged file, grep
      # across files, read an unchanged consumer. Prints the size of every model request.
      make_repo "$work/repo-workload" BIGFILE=1
      run_case workload workload "$work/repo-workload" REVIEW_AGENTS=security
      d="$work/workload"
      echo "  exit=$(rc workload)"
      echo "  model request sizes (bytes, in order; tool-enabled requests only):"
      grep '"event":"request"' "$d/proxy.log" | grep '"has_tools":true' | grep -o '"bytes":[0-9]*' | cut -d: -f2 | paste -sd' ' - | sed 's/^/    /'; echo
      [ "$(rc workload)" = 0 ] && pass "the review completed" || fail "exit code $(rc workload)"
      done_n=$(grep '"event":"tool_call"' "$d/run.jsonl" | grep -c '"tool":"cra_[a-z]*","status":"completed"')
      [ "$done_n" = 4 ] && pass "all 4 scripted cra_* calls completed" || fail "completed cra_* calls: $done_n"
      max=$(grep '"event":"request"' "$d/proxy.log" | grep '"has_tools":true' | grep -o '"bytes":[0-9]*' | cut -d: -f2 | sort -n | tail -1)
      [ "${max:-999999}" -lt 40000 ] && pass "largest tool-enabled request is $max bytes (< 40000)" || fail "largest request $max bytes"
      has "$d/requests.jsonl" "ORDER_LINE_100 " && pass "the first chunk (lines up to 100) reached the model" || fail "first chunk missing"
      has "$d/requests.jsonl" "ORDER_LINE_150 " && pass "the continuation chunk (offset 101) reached the model" || fail "continuation missing"
      has "$d/requests.jsonl" "TRUNCATED" && pass "the truncation marker with a continuation offset reached the model" || fail "no truncation marker"
      has "$d/requests.jsonl" "ORDER_LINE_650 " && fail "the whole file reached the model" || pass "the rest of the large file never reached the model"
      has "$d/requests.jsonl" "orders.ts:401:" && has "$d/requests.jsonl" "lookupForReport" && pass "cross-file grep found callers and the unchanged consumer was read" || fail "grep/consumer content missing"
      ;;
    budget)
      # A model that keeps investigating until the proxy's request budget (3) is spent. Observe how OpenCode 1.19.5
      # handles the proxy's answer, then check CRA ends the review incomplete without retrying.
      make_repo "$work/repo-budget"
      run_case budget loop "$work/repo-budget" REVIEW_AGENTS=code_quality REVIEW_INVESTIGATION_STEPS=20 PROXY_MAX_REQUESTS=3
      d="$work/budget"
      echo "  exit=$(rc budget)"; sed -n '1,12p' "$d/report.md" | sed 's/^/    /'
      grep -E '"event":"(attempt_failed|reviewer_failed|attempt_start|session_cleanup)"' "$d/run.jsonl" | sed 's/"ts":"[^"]*",//' | cut -c1-260 | sed 's/^/    /'
      [ "$(rc budget)" = 2 ] && pass "exit 2" || fail "exit code $(rc budget), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined" || fail "wrong verdict"
      has "$d/report.md" "model_budget" && pass "failure is named budget" || fail "failure not named"
      grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -q '"kind":"budget".*"decision":"stop_not_retryable"' && pass "decision logged: budget, stop_not_retryable" || fail "attempt decision not logged"
      [ "$(grep -c '"event":"request"' "$d/proxy.log")" = 3 ] && pass "exactly 3 requests were forwarded upstream" || fail "forwarded request count is not 3"
      [ "$(grep -c '"event":"budget_exhausted"' "$d/proxy.log")" = 1 ] && pass "exactly 1 request was refused: OpenCode did not retry it" || fail "refused request count is not 1"
      [ "$(grep -c '"event":"attempt_start"' "$d/run.jsonl")" = 1 ] && pass "no retry or fallback attempt" || fail "extra attempts"
      grep -q 'compaction' "$d/stub.log" && fail "a compaction request was made" || pass "no compaction request"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "the session was cancelled, confirmed idle and deleted" || fail "session cleanup incomplete"
      ;;
    budget_stubborn)
      # The worst case: a model that ignores the step instruction, with the step cap raised out of reach (50). Only the
      # proxy's request budget (6) stands between the model and an unbounded number of provider requests.
      make_repo "$work/repo-budget-stubborn"
      run_case budget_stubborn loop_stubborn "$work/repo-budget-stubborn" REVIEW_AGENTS=code_quality REVIEW_INVESTIGATION_STEPS=50 PROXY_MAX_REQUESTS=6
      d="$work/budget_stubborn"
      echo "  exit=$(rc budget_stubborn)"
      [ "$(rc budget_stubborn)" = 2 ] && pass "exit 2" || fail "exit code $(rc budget_stubborn), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined" || fail "wrong verdict"
      [ "$(grep -c '"event":"request"' "$d/proxy.log")" = 6 ] && pass "exactly 6 requests reached the provider side (the budget), however long the model wanted to go" || fail "forwarded requests: $(grep -c '"event":"request"' "$d/proxy.log")"
      [ "$(grep -c '"event":"budget_exhausted"' "$d/proxy.log")" = 1 ] && pass "exactly 1 further request was refused, and OpenCode did not retry it" || fail "refused count: $(grep -c '"event":"budget_exhausted"' "$d/proxy.log")"
      [ "$(grep -c '"event":"attempt_start"' "$d/run.jsonl")" = 1 ] && pass "no retry or fallback attempt" || fail "extra attempts"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "the session was cancelled, confirmed idle and deleted" || fail "session cleanup incomplete"
      ;;
    mcpdown)
      # CRA's MCP server cannot start. The review must end incomplete; OpenCode's unbounded built-ins are never a fallback.
      make_repo "$work/repo-mcpdown"
      run_case mcpdown report "$work/repo-mcpdown" REVIEW_AGENTS=security "CRL_COMPOSE_EXTRA=$rootn/tests/integration/compose.mcpdown.yml"
      d="$work/mcpdown"
      echo "  exit=$(rc mcpdown)"; sed -n '1,12p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc mcpdown)" = 2 ] && pass "exit 2" || fail "exit code $(rc mcpdown), expected 2"
      has "$d/report.md" "Verdict: not_determined" && pass "verdict is not_determined" || fail "wrong verdict"
      has "$d/report.md" "model_tooling" && pass "failure is named tooling" || fail "failure not named"
      grep '"event":"attempt_failed"' "$d/run.jsonl" | grep -q '"kind":"tooling".*"decision":"stop_not_retryable"' && pass "decision logged: tooling, stop_not_retryable" || fail "attempt decision not logged"
      tool_requests=$(grep -c '"toolNames"' "$d/stub.log" 2>/dev/null); tool_requests=${tool_requests:-0}
      [ "$tool_requests" = 0 ] && pass "no tool-enabled model request was made (no fallback to built-ins)" || fail "$tool_requests tool-enabled request(s) reached the model"
      ;;
    hostile)
      # A repository that tries to run code and to gain system-prompt authority through agent configuration.
      # Part 1: probes inside the agent container. The CONTROL run (project config on, what CRA did before) must be
      # compromised, or the test proves nothing; the PROTECTED run (CRA's launch) must be untouched.
      pj="crl-hostileprobe"; mkdir -p "$work/hostile-probe"
      ( export STUB_MODE=obey COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" build --quiet agent >/dev/null 2>&1   # never run a stale image
        docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" up -d proxy stub >/dev/null 2>&1
        for mode in 1 0; do
          docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" run --rm --no-deps -e CONTROL=$mode -v "$rootn/tests/integration:/probe:ro" --entrypoint node agent /probe/hostile-probe.mjs >"$work/hostile-probe/probe$mode.out" 2>"$work/hostile-probe/probe$mode.err"
          docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" logs --no-log-prefix stub >"$work/hostile-probe/stub$mode.log" 2>&1
        done )
      c="$work/hostile-probe/probe1.out"; p="$work/hostile-probe/probe0.out"
      echo "  control (project config ON):"; grep '"fact":"result"' "$c" | cut -c1-260 | sed 's/^/    /'
      echo "  protected (CRA launch):";      grep '"fact":"result"' "$p" | cut -c1-260 | sed 's/^/    /'
      for k in plugin tool mcp; do has "$c" "PWNED_$k" && pass "control: hostile $k ran (the fixture is potent)" || fail "control: hostile $k did not run, so this test proves nothing"; done
      has "$c" '"reportForged":true' && pass "control: the hostile code overwrote the report (writable /review/out)" || fail "control: report not forged"
      has "$c" '"toolIdsContainEvil":true' && pass "control: the repository's own tool was registered" || fail "control: evil tool not registered"
      has "$work/hostile-probe/stub1.log" 'HOSTILE_AGENTS_MD_MARKER' && pass "control: AGENTS.md reached the model" || fail "control: AGENTS.md did not reach the model"
      has "$p" '"pwnedMarkers":[]' && pass "protected: no hostile plugin, tool or MCP server executed" || fail "protected: something executed"
      has "$p" '"reportForged":false' && pass "protected: the report was not touched" || fail "protected: report forged"
      has "$p" '"toolIdsContainEvil":false' && pass "protected: the repository could not register a tool" || fail "protected: evil tool registered"
      has "$p" '"mcpServers":["cra"]' && pass "protected: the only MCP server is CRA's own (cra); no repository server was started" || fail "protected: unexpected MCP servers"
      n=$(tail -n +$(( $(wc -l <"$work/hostile-probe/stub1.log") + 1 )) "$work/hostile-probe/stub0.log" | grep -c 'HOSTILE_' || true); [ "$n" = 0 ] && pass "protected: no repository instruction text (AGENTS.md, CLAUDE.md, skills, agents, commands) reached the model" || fail "protected: $n model request(s) carried repository instruction text"
      COMPOSE_PROFILES=stub REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "$pj" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" down -v >/dev/null 2>&1
      # Part 2: the whole pipeline on a hostile repository. The snapshot must not contain the agent configuration.
      make_repo "$work/repo-hostile" HOSTILE=1
      run_case hostile report "$work/repo-hostile" REVIEW_AGENTS=security
      d="$work/hostile"
      echo "  exit=$(rc hostile)"; sed -n '1,10p' "$d/report.md" | sed 's/^/    /'
      [ "$(rc hostile)" = 0 ] && has "$d/report.md" '`src/users.ts:4`' && pass "the review still completes and finds the seeded bug" || fail "review did not complete normally (exit $(rc hostile))"
      has "$d/report.md" "FORGED" && fail "the report was forged" || pass "the report was not forged"
      ls "$d" | grep -q '^PWNED_' && fail "a hostile payload wrote into /review/out" || pass "no hostile payload wrote into /review/out"
      n=$(grep -c 'HOSTILE_' "$d/requests.jsonl" 2>/dev/null); [ "$n" = 0 ] && pass "no repository instruction text reached any model request" || fail "$n model request(s) carried repository instruction text"
      snap=$(MSYS_NO_PATHCONV=1 docker run --rm -v "crl-hostile_repo_ws:/repo:ro" --entrypoint sh "crl-hostile-agent" -c 'ls -A /repo; ls -A /repo/.claude /repo/.agents 2>/dev/null' 2>&1)
      echo "$snap" | grep -qE '^\.opencode$|^opencode\.jsonc?$' && fail "the snapshot contains agent configuration: $snap" || pass "the sanitised snapshot excludes .opencode/, opencode.json and opencode.jsonc"
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
    history|history_long)
      # Bounded tool-result history, provider-free. The SAME scripted investigation (STUB_CALLS tool calls on a fixture with a
      # 700-line file: early read of src/users.ts, a forbidden bash call, an out-of-root read, paging, greps, a re-read of
      # src/users.ts near the end) runs with pruning OFF and ON. Bytes, not tokens.
      calls=20; [ "$s" = history_long ] && calls=40
      make_repo "$work/repo-$s" BIGFILE=1
      for variant in off on; do
        extra=(); [ "$variant" = on ] && extra=(REVIEW_HISTORY_BUDGET_BYTES=8000)
        run_case "${s}_$variant" long "$work/repo-$s" REVIEW_AGENTS=code_quality REVIEW_MAX_RETRIES=0 REVIEW_INVESTIGATION_STEPS=$((calls + 2)) PROXY_MAX_REQUESTS=$((calls + 10)) STUB_CALLS=$calls "${extra[@]}"
        d="$work/${s}_$variant"
        echo "  [$variant] exit=$(rc "${s}_$variant")"
        h=$(node "$rootn/tests/integration/inspect-history.mjs" "$d/requests.jsonl" "$d/proxy.log" "$d/run.jsonl"); echo "    $h" | cut -c1-900
        eval "h_$variant=\$h"
        [ "$(rc "${s}_$variant")" = "$(rc "${s}_off")" ] && pass "[$variant] same exit code as the unpruned run ($(rc "${s}_$variant"))" || fail "[$variant] exit code differs from the unpruned run"
        n=$(grep '"event":"tool_call"' "$d/run.jsonl" | grep -c '"tool":"cra_[a-z]*","status":"completed"'); [ "$n" -ge $((calls - 2)) ] && pass "[$variant] $n cra_* tool calls completed (>= $((calls - 2)); two scripted calls are forbidden)" || fail "[$variant] only $n cra_* calls completed"
        grep '"event":"tool_call"' "$d/run.jsonl" | grep '"tool":"bash"' | grep -q '"status":"completed"' && fail "[$variant] forbidden bash completed" || pass "[$variant] forbidden bash call did not complete"
        grep '"event":"tool_call"' "$d/run.jsonl" | grep '/etc/passwd' | grep -q '"status":"completed"' && fail "[$variant] out-of-root read completed" || pass "[$variant] out-of-root read did not complete"
        [ ! -e "$d/pwned.txt" ] && pass "[$variant] nothing created in /review/out" || fail "[$variant] unexpected file in /review/out"
        grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "[$variant] session cancelled, idle and deleted" || fail "[$variant] session cleanup not confirmed"
      done
      j() { node -e "const h=JSON.parse(process.argv[1]);const v=process.argv[2].split('.').reduce((a,k)=>a?.[k],h);console.log(Array.isArray(v)?v.join(','):v)" "$1" "$2"; }
      echo "  OFF: first=$(j "$h_off" first) max=$(j "$h_off" max) total=$(j "$h_off" total) slope/req=$(j "$h_off" slopeBytesPerRequest)"
      echo "  ON : first=$(j "$h_on" first) max=$(j "$h_on" max) total=$(j "$h_on" total) slope/req=$(j "$h_on" slopeBytesPerRequest)"
      [ "$(j "$h_on" max)" -lt "$(j "$h_off" max)" ] && pass "pruning lowered the largest request ($(j "$h_off" max) -> $(j "$h_on" max) bytes)" || fail "pruning did not lower the largest request"
      [ "$(j "$h_on" total)" -lt "$(j "$h_off" total)" ] && pass "pruning lowered total request bytes ($(j "$h_off" total) -> $(j "$h_on" total))" || fail "pruning did not lower total request bytes"
      [ "$(j "$h_on" lastPrunedRefs)" -gt 0 ] && pass "the last request carried $(j "$h_on" lastPrunedRefs) pruned references" || fail "no pruned references were sent"
      [ "$(j "$h_off" lastPrunedRefs)" = 0 ] && pass "the unpruned run sent no references" || fail "references appeared with pruning off"
      [ "$(j "$h_on" proxy.historyDenied)" = 0 ] && pass "the proxy refused no request: every tool-enabled request was stamped" || fail "the proxy refused $(j "$h_on" proxy.historyDenied) request(s)"
      [ "$(j "$h_on" proxy.stamped)" = "$(j "$h_on" proxy.forwarded)" ] || [ "$(j "$h_on" proxy.stamped)" -ge "$(j "$h_on" toolRequests)" ] && pass "every tool-enabled request carried the stamp ($(j "$h_on" proxy.stamped) stamped)" || fail "stamp count does not cover the tool-enabled requests"
      [ "$(j "$h_off" proxy.stamped)" = 0 ] && pass "no stamp when pruning is off" || fail "stamps appeared with pruning off"
      has "$work/${s}_on/run.jsonl" '"event":"history_pruning"' && pass "history_pruning telemetry was recorded" || fail "history_pruning telemetry missing"
      grep '"event":"history_pruning"' "$work/${s}_on/run.jsonl" | grep -q '"verdict":"ok"' && pass "driver verdict: pruned for every model request" || fail "driver verdict is not ok"
      has "$work/${s}_off/run.jsonl" '"event":"history_pruning"' && fail "history telemetry appeared with pruning off" || pass "no pruning telemetry when it is off"
      hs=$(j "$h_on" usersReadHashes); first=${hs%%,*}; lastr=${hs##*,}
      [ -n "$first" ] && [ "$first" = "$lastr" ] && [ "$hs" != "$first" ] && pass "src/users.ts re-read after its result was pruned returned identical bytes (sha256 prefix $first)" || fail "re-read hash mismatch or missing: $hs"
      ;;
    history_guard)
      # Pruning ON with the existing safety scenarios: forbidden tools, step cap, hostile repository.
      make_repo "$work/repo-hg-attack"
      run_case hg_attack attack "$work/repo-hg-attack" REVIEW_AGENTS=security REVIEW_HISTORY_BUDGET_BYTES=8000
      d="$work/hg_attack"; echo "  attack: exit=$(rc hg_attack)"
      for t in bash write edit webfetch; do grep '"event":"tool_call"' "$d/run.jsonl" | grep "\"tool\":\"$t\"" | grep -q '"status":"completed"' && fail "[attack+pruning] forbidden tool '$t' completed" || pass "[attack+pruning] forbidden tool '$t' did not complete"; done
      escapes=$(grep '"event":"tool_call"' "$d/run.jsonl" | grep '"tool":"cra_' | grep -vc '"status":"error"'); [ "$escapes" = 0 ] && pass "[attack+pruning] every out-of-bounds cra_* call was refused" || fail "[attack+pruning] $escapes out-of-bounds call(s) not refused"
      offered=$(grep -o '"toolNames":\[[^]]*\]' "$d/stub.log" | sort -u | paste -sd, -); [ "$offered" = '"toolNames":["cra_glob","cra_grep","cra_list","cra_read"]' ] && pass "[attack+pruning] only the four cra_* tools were offered" || fail "[attack+pruning] tool set: $offered"
      [ ! -e "$d/pwned.txt" ] && [ ! -e "$d/env.txt" ] && pass "[attack+pruning] no file created" || fail "[attack+pruning] a forbidden write created a file"
      grep '"event":"history_pruning"' "$d/run.jsonl" | grep -q '"verdict":"ok"' && pass "[attack+pruning] pruning verified for the investigation" || fail "[attack+pruning] pruning verdict missing"
      make_repo "$work/repo-hg-cap"
      run_case hg_cap loop "$work/repo-hg-cap" REVIEW_AGENTS=code_quality REVIEW_INVESTIGATION_STEPS=3 REVIEW_HISTORY_BUDGET_BYTES=8000
      d="$work/hg_cap"; echo "  step cap: exit=$(rc hg_cap)"
      nt=$(grep -c '"kind":"loop_tool"' "$d/stub.log"); nf=$(grep -c '"kind":"loop_final"' "$d/stub.log")
      [ "$nt" = 2 ] && [ "$nf" = 1 ] && pass "[stepcap+pruning] cap still limited the investigation to 3 model calls" || fail "[stepcap+pruning] $nt tool-turn and $nf final requests"
      [ "$(rc hg_cap)" = 2 ] && has "$d/report.md" "investigation_truncated" && pass "[stepcap+pruning] capped investigation still ends incomplete (exit 2, investigation_truncated)" || fail "[stepcap+pruning] wrong outcome"
      grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "[stepcap+pruning] session cleaned up" || fail "[stepcap+pruning] cleanup not confirmed"
      make_repo "$work/repo-hg-hostile" HOSTILE=1
      run_case hg_hostile report "$work/repo-hg-hostile" REVIEW_AGENTS=security REVIEW_HISTORY_BUDGET_BYTES=8000
      d="$work/hg_hostile"; echo "  hostile repo: exit=$(rc hg_hostile)"
      n=$(grep -c 'HOSTILE_' "$d/stub.log" || true); [ "$n" = 0 ] && pass "[hostile+pruning] no repository instruction text reached the model" || fail "[hostile+pruning] $n request(s) carried hostile text"
      ls "$d" | grep -qi 'pwned' && fail "[hostile+pruning] hostile code left a file" || pass "[hostile+pruning] no hostile artifact in the output"
      grep '"event":"history_pruning"' "$d/run.jsonl" | grep -q '"verdict":"ok"' && pass "[hostile+pruning] pruning verified" || fail "[hostile+pruning] pruning verdict missing"
      ;;
    history_broken)
      # Pruning is configured but the plugin is broken in three different ways. Each must end the review incomplete and
      # must not let any unpruned tool-enabled request reach the model.
      make_repo "$work/repo-hb"
      for v in loadfail inert hookfail; do
        run_case "hb_$v" long "$work/repo-hb" REVIEW_AGENTS=code_quality REVIEW_MAX_RETRIES=0 REVIEW_INVESTIGATION_STEPS=8 STUB_CALLS=4 REVIEW_HISTORY_BUDGET_BYTES=8000 "CRL_COMPOSE_EXTRA=$rootn/tests/integration/compose.history-$v.yml"
        d="$work/hb_$v"; echo "  [$v] exit=$(rc "hb_$v")"; sed -n '1,12p' "$d/report.md" | sed 's/^/    /'
        grep -E '"event":"(attempt_failed|history_pruning)"' "$d/run.jsonl" | sed 's/"ts":"[^"]*",//' | cut -c1-300 | sed 's/^/    /'
        [ "$(rc "hb_$v")" = 2 ] && pass "[$v] exit 2" || fail "[$v] exit code $(rc "hb_$v"), expected 2"
        has "$d/report.md" "Verdict: not_determined" && pass "[$v] verdict is not_determined" || fail "[$v] wrong verdict"
        tr=$(grep -c '"toolNames"' "$d/stub.log" 2>/dev/null); tr=${tr:-0}
        [ "$tr" = 0 ] && pass "[$v] zero tool-enabled requests reached the model" || fail "[$v] $tr tool-enabled request(s) reached the model"
        [ "$(grep -c '"event":"attempt_start"' "$d/run.jsonl")" = 1 ] && pass "[$v] no retry or fallback attempt" || fail "[$v] extra attempts"
        grep '"event":"session_cleanup"' "$d/run.jsonl" | grep -q '"abort":"ok".*"idle":true.*"delete":"ok"' && pass "[$v] session cleaned up" || fail "[$v] cleanup not confirmed"
        echo "    proxy: denied=$(grep -c '"event":"history_denied"' "$d/proxy.log") forwarded=$(grep -c '"event":"request"' "$d/proxy.log")"
        teardown "hb_$v"
      done
      ;;
    *) fail "unknown scenario: $s" ;;
  esac
  # OS-level probe inside an agent container with this scenario's real mounts, network and limits.
  if [ "$s" = report ]; then
    echo "  -- container probe"
    probe_out=$(COMPOSE_PROFILES=stub MSYS_NO_PATHCONV=1 REVIEW_REPO_DIR=. REVIEW_BASE=x REVIEW_HEAD=y docker compose -p "crl-$s" -f "$rootn/docker/compose.yml" -f "$rootn/docker/compose.offline.yml" run --rm --no-deps -v "$rootn/tests/integration/probe-agent.sh:/probe.sh:ro" agent sh /probe.sh 2>&1)
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
