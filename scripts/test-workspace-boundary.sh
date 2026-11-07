#!/bin/bash
# Docker security check for the reviewer workspace (Task 4B). Needs Docker. Uses synthetic secrets only.
# Verifies enforced denials from inside the agent container; it does not rely on a model refusing anything.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

# Random-looking synthetic values, generated per run. None is a real credential.
gen() { head -c 200 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-36; }
export MARK1="Zq$(gen)" MARK2="Hn$(gen)" MARK3="Vb$(gen)" MARK4="Kd$(gen)" MARK5="Wp$(gen)" MARK6="Rt$(gen)"
MARKS="$MARK1 $MARK2 $MARK3 $MARK4 $MARK5 $MARK6"

C="docker compose -f docker/compose.workspace.yml"
failed=0
ok()  { echo "OK   $1"; }
bad() { echo "FAIL $1"; failed=1; }

fresh() { $C down -v --remove-orphans >/dev/null 2>&1; $C --profile test run --rm --build fixture >/dev/null || { bad "fixture build"; exit 1; }; }
cleanup() { $C --profile test down -v --remove-orphans >/dev/null 2>&1; }
trap cleanup EXIT

echo "== Scenario A: successful preparation, probe the agent container"
fresh
if out=$($C run --rm -e MARKS="$MARKS" --entrypoint sh agent /probe.sh 2>&1); then ok "probe: all boundary checks passed"; else bad "probe reported failures"; fi
echo "$out" | grep -E "^PROBE (PASS|FAIL|DONE)" | sed 's/^/    /'
echo "$out" | grep -q "PROBE FAIL" && bad "at least one PROBE FAIL"

echo "== Control: the probe must FAIL if the raw checkout is mounted into the agent (proves the checks are not vacuous)"
out=$($C run --rm --no-deps -v crl-workspace_raw:/raw:ro -e MARKS="$MARKS" --entrypoint sh agent /probe.sh 2>&1); rc=$?
[ $rc -ne 0 ] && ok "probe detects an exposed raw checkout (exit $rc)" || bad "probe passed with raw checkout mounted: checks are vacuous"
echo "$out" | grep "PROBE FAIL" | sed 's/^/    /' | head -8

echo "== Scenario B: source missing -> prep fails -> agent must not start"
fresh
out=$(REVIEW_SOURCE_DIR=/raw/nonexistent $C run --rm -e MARKS="$MARKS" --entrypoint sh agent /probe.sh 2>&1); rc=$?
[ $rc -ne 0 ] && ok "compose exit code $rc" || bad "agent started despite failed preparation"
echo "$out" | grep -q "PROBE" && bad "probe ran although prep failed" || ok "agent container never ran"
$C logs prep 2>&1 | grep -q '"code":"source_missing"' && ok "explicit error status: source_missing" || bad "no explicit error status"

echo "== Scenario C: unparsable diff -> prep fails; a forced agent start finds no READY marker"
fresh
out=$(REVIEW_DIFF_FILE=/raw/bad.patch $C run --rm -e MARKS="$MARKS" --entrypoint sh agent /probe.sh 2>&1); rc=$?
[ $rc -ne 0 ] && ok "compose exit code $rc" || bad "agent started despite failed preparation"
$C logs prep 2>&1 | grep -q '"code":"diff_parse_failed"' && ok "explicit error status: diff_parse_failed" || bad "no explicit error status"
out=$($C run --rm --no-deps -e MARKS="$MARKS" --entrypoint sh agent /probe.sh 2>&1)
echo "$out" | grep -q "PROBE FAIL ready marker present" && ok "no READY marker when preparation failed" || bad "READY marker present after failure"

echo "== Secrets must not appear in prep output or compose logs"
fresh
logs=$($C run --rm prep 2>&1; $C logs 2>&1)
for m in $MARKS; do echo "$logs" | grep -q -F "$m" && bad "secret value in logs" || true; done
ok "log scan done"

[ $failed -eq 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
