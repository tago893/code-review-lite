#!/bin/sh
# Runs INSIDE the agent container. Checks the access boundary the OS enforces, not what a model chooses to do.
# MARKS is a space-separated list of the synthetic secret values that exist only in the raw checkout.
fails=0
pass() { echo "PROBE PASS $1"; }
fail() { echo "PROBE FAIL $1"; fails=$((fails + 1)); }
check() { # check <name> <command...>  (passes when the command succeeds)
  name=$1; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}
denied() { # denied <name> <command...>  (passes when the command FAILS)
  name=$1; shift
  if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi
}

# 0. The workspace was prepared successfully.
check "ready marker present" test -f /review/context/READY
check "manifest present" test -f /review/context/manifest.json
check "diff context present" test -f /review/context/diff.patch

# 1. No raw secret exists anywhere in this container's filesystem (what read/grep/glob could ever reach).
for m in $MARKS; do
  hits=$(grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e "$m" / 2>/dev/null | grep -v '^/probe.sh$')
  [ -z "$hits" ] && pass "secret value absent from filesystem ($(echo "$m" | cut -c1-4)...)" || fail "secret value found in: $hits"
  hits=$(rg -uuu --hidden -l -F -e "$m" /repo /review/context 2>/dev/null)
  [ -z "$hits" ] && pass "rg (grep tool engine) finds nothing in /repo, /review/context" || fail "rg found secret in: $hits"
done

# 2. Excluded material is absent from the snapshot.
denied ".git absent" test -e /repo/.git
denied ".env absent" test -e /repo/.env
denied "env variants absent" test -e /repo/.env.production
denied "pem file absent" test -e /repo/deploy/server.pem
denied "git history unreachable (git log fails)" git -C /repo log
check "env template kept" test -f /repo/.env.example
denied "no symlinks in /repo" sh -c 'test -n "$(find /repo -type l)"'
denied "no fifo or special files" sh -c 'test -n "$(find /repo ! -type f ! -type d)"'

# 3. Symlink escapes fail.
denied "symlink to /etc not present" test -e /repo/src/escape
denied "read through escape link fails" cat /repo/src/escape/hostname
denied "link to raw .env not present" cat /repo/src/abs_env
denied "relative link to .env not present" cat /repo/src/rel_env

# 4. The raw checkout and host are not reachable.
denied "/raw does not exist" test -e /raw
denied "read raw .env fails" cat /raw/repo/.env
denied "read raw history fails" cat /raw/repo/.git/leak.txt
denied "host drive mounts absent" sh -c 'test -e /mnt/c -o -e /host_mnt -o -e /Users'
denied "no mount mentions raw" sh -c 'grep -q "/raw" /proc/self/mountinfo'

# 5. The snapshot is read-only at the mount level.
denied "cannot create a file in /repo" touch /repo/new.txt
denied "cannot modify a file in /repo" sh -c 'echo x >> /repo/src/app.ts'
denied "cannot delete from /repo" rm /repo/src/app.ts
denied "cannot write to /review/context" touch /review/context/new.txt
check "/repo mounted ro" sh -c "grep ' /repo ' /proc/self/mountinfo | grep -q ' ro'"
check "/review/context mounted ro" sh -c "grep ' /review/context ' /proc/self/mountinfo | grep -q ' ro'"

# 6. Review locations survive redaction.
[ "$(sed -n 3p /repo/src/app.ts)" = 'const apiKey = "[REDACTED]";' ] && pass "app.ts line 3 redacted in place" || fail "app.ts line 3"
[ "$(sed -n 1p /repo/src/app.ts)" = '// app' ] && [ "$(sed -n 4p /repo/src/app.ts)" = 'export default name;' ] && pass "app.ts neighbours unchanged" || fail "app.ts neighbours"
[ "$(wc -l < /repo/src/app.ts)" = 4 ] && pass "app.ts line count unchanged" || fail "app.ts line count"
[ "$(sed -n 2p /repo/a/b/c/d/deep.ts)" = 'const password = "[REDACTED]";' ] && pass "nested path keeps line 2" || fail "nested path"
[ "$(sed -n 1p '/repo/dir with space/file name.ts')" = ok ] && pass "path with spaces preserved" || fail "path with spaces"
[ "$(sed -n 1p /repo/deploy/notes.txt)" = '-----BEGIN RSA PRIVATE KEY-----' ] && [ "$(sed -n 2p /repo/deploy/notes.txt)" = '[REDACTED]' ] \
  && [ "$(sed -n 4p /repo/deploy/notes.txt)" = '-----END RSA PRIVATE KEY-----' ] && [ "$(sed -n 5p /repo/deploy/notes.txt)" = after ] \
  && pass "pasted PEM block redacted, later lines keep their numbers" || fail "pasted PEM block"
check "diff context carries the redacted line" grep -q 'const apiKey = "\[REDACTED\]";' /review/context/diff.patch
denied "diff context omits the withheld .env content" grep -q 'DB_PASSWORD' /review/context/diff.patch
check "manifest lists the withheld .env" grep -q '"withheldFromDiff"' /review/context/manifest.json

echo "PROBE DONE failures=$fails"
[ "$fails" = 0 ]
