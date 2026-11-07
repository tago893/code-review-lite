#!/bin/sh
# TEST ONLY. Builds a raw checkout full of SYNTHETIC secrets inside the `raw` volume.
# MARK1..MARK6 are random-looking strings supplied by the test runner; none is a real credential.
set -eu
: "${MARK1:?}" "${MARK2:?}" "${MARK3:?}" "${MARK4:?}" "${MARK5:?}" "${MARK6:?}"

R=/raw/repo
rm -rf /raw/* /raw/.[!.]* 2>/dev/null || true
mkdir -p "$R/src" "$R/deploy" "$R/a/b/c/d" "$R/dir with space"

# Line 3 holds a provider key; the review location must survive redaction.
printf '%s\n' '// app' 'export const name = "demo";' "const apiKey = \"gsk_${MARK1}\";" 'export default name;' > "$R/src/app.ts"
printf '%s\n' 'x' "const password = \"${MARK6}\";" 'y' > "$R/a/b/c/d/deep.ts"
printf '%s\n' 'ok' > "$R/dir with space/file name.ts"
printf 'DB_PASSWORD=%s\n' "$MARK2" > "$R/.env"
printf 'TOKEN=\n' > "$R/.env.example"

# A PEM file under an excluded name, and a PEM block pasted into an ordinary file.
{ echo '-----BEGIN RSA PRIVATE KEY-----'; echo "$MARK4"; echo '-----END RSA PRIVATE KEY-----'; } > "$R/deploy/server.pem"
{ echo '-----BEGIN RSA PRIVATE KEY-----'; echo "$MARK5"; echo "${MARK5}x"; echo '-----END RSA PRIVATE KEY-----'; echo 'after'; } > "$R/deploy/notes.txt"

# Raw git history: a secret committed and then removed, so only history holds it. A plain-text file inside
# .git stands in for packed/compressed objects, which grep cannot see into.
cd "$R"
git init -q .
printf 'const k = "gsk_%s";\n' "$MARK3" > old.ts
git add old.ts
git -c user.name=t -c user.email=t@example.com commit -q -m "add"
git rm -q old.ts
git -c user.name=t -c user.email=t@example.com commit -q -m "remove"
printf 'leak %s\n' "$MARK3" > .git/leak.txt

# Symlinks that point out of the checkout, into the raw secrets, and nowhere.
ln -s /etc src/escape
ln -s /raw/repo/.env src/abs_env
ln -s ../.env src/rel_env
ln -s ../../nowhere src/dangling
mkfifo src/pipe

cat > /raw/diff.patch <<EOF
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,4 @@
 // app
 export const name = "demo";
+const apiKey = "gsk_${MARK1}";
+export default name;
diff --git a/.env b/.env
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+DB_PASSWORD=${MARK2}
EOF
printf 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ not a hunk header @@\n' > /raw/bad.patch
echo "fixture ready"
