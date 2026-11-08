#!/bin/sh
# Runs INSIDE the agent container (same image, user, mounts, network and limits as a real review).
# It checks what the operating system and Docker enforce, not what a model chooses to do.
# Pass criteria print "PROBE PASS"; any "PROBE FAIL" makes the exit status non-zero.
fails=0
pass() { echo "PROBE PASS $1"; }
fail() { echo "PROBE FAIL $1"; fails=$((fails + 1)); }
check() { name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
denied() { name=$1; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }

# --- identity and mounts -------------------------------------------------------------------------------------
[ "$(id -u)" != "0" ] && pass "not root (uid $(id -u))" || fail "running as root"
denied "/repo is read-only (create file)" touch /repo/probe-write
denied "/repo is read-only (overwrite existing)" sh -c 'f=$(find /repo -type f | head -n 1); [ -n "$f" ] && echo x >> "$f"'
denied "/review/context is read-only" touch /review/context/probe-write
check "/review/out is writable" sh -c 'touch /review/out/probe-write && rm /review/out/probe-write'
denied "root filesystem is read-only" touch /probe-root-write
denied "docker socket absent" test -e /var/run/docker.sock
denied "raw checkout mount absent (/raw)" test -e /raw
denied ".git absent from /repo" test -e /repo/.git
denied "no host home mounted" sh -c 'mount | grep -Ei "/(users|home)/(varun|[a-z]+)/" | grep -v "/home/node"'
check "READY marker present" test -f /review/context/READY
[ -z "$(find /repo /review/context -type l 2>/dev/null)" ] && pass "no symlinks in snapshot" || fail "symlinks present in snapshot"

# --- credentials ---------------------------------------------------------------------------------------------
denied "no provider key variable in environment" sh -c 'env | grep -Ei "groq_api_key|api_key|secret|token|password"'
denied "no key-shaped value in any /proc/*/environ" sh -c 'cat /proc/[0-9]*/environ 2>/dev/null | tr "\0" "\n" | grep -E "gsk_[A-Za-z0-9]{10,}|GROQ_API_KEY"'
denied "no key-shaped value anywhere in the readable filesystem" sh -c 'grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -E "gsk_[A-Za-z0-9]{20,}" / 2>/dev/null'

# --- network -------------------------------------------------------------------------------------------------
net() { node -e "const t=setTimeout(()=>process.exit(3),6000);fetch(process.argv[1],{method:process.argv[2]||'GET'}).then(r=>{console.log(r.status);process.exit(r.status<400?0:4)},()=>process.exit(1))" "$@"; }
denied "cannot reach api.groq.com directly" net https://api.groq.com/openai/v1/models
denied "cannot reach the public internet (1.1.1.1)" net http://1.1.1.1/
denied "cannot reach example.com" net https://example.com/
status=$(node -e "fetch('http://proxy:8080/v1/files').then(r=>console.log(r.status),()=>console.log('ERR'))" 2>/dev/null)
[ "$status" = "403" ] && pass "proxy refuses an off-allow-list path (403)" || fail "proxy off-list path returned '$status'"
status=$(node -e "fetch('http://proxy:8080/openai/v1/chat/completions',{method:'DELETE'}).then(r=>console.log(r.status),()=>console.log('ERR'))" 2>/dev/null)
[ "$status" = "403" ] && pass "proxy refuses a disallowed method (403)" || fail "proxy disallowed method returned '$status'"

# --- OpenCode ------------------------------------------------------------------------------------------------
check "opencode binary present" opencode --version
check "ripgrep present for grep/glob tools" rg --version

echo "PROBE SUMMARY failures=$fails"
[ "$fails" -eq 0 ]
