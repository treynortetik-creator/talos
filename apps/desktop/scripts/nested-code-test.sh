#!/usr/bin/env bash
# Tests nested-code.sh on a fake bundle with real Mach-O files: a universal binary (two slices), a single-arch one, one inside a
# framework, a script and a text file (not code), one with spaces and one with a colon in its name. It must print exactly the binaries,
# deepest first. A control runs the finder as build-app.sh had it before 1f62deff4 and checks the same bundle breaks it, so this test
# can go red on that bug.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FIND="$HERE/nested-code.sh"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d "${TMPDIR:-/tmp}/talos-nested-test-XXXXXX")"; trap 'rm -rf "$T"' EXIT
cat > "$T/p.c" <<'C'
int main(void) { return 0; }
C
cc -arch arm64 -o "$T/a64" "$T/p.c" 2>/dev/null && cc -arch x86_64 -o "$T/x64" "$T/p.c" 2>/dev/null || { echo "nested-code-test: this Mac cannot compile both slices" >&2; exit 2; }
lipo -create "$T/a64" "$T/x64" -output "$T/uni" || { echo "nested-code-test: lipo failed" >&2; exit 2; }
A="$T/Talos.app/Contents"
mkdir -p "$A/MacOS" "$A/Helpers" "$A/Frameworks/Fw.framework/Versions/A" "$A/Resources/odd dir"
cp "$T/a64" "$A/MacOS/Talos"
cp "$T/uni" "$A/Helpers/bun"
cp "$T/a64" "$A/Helpers/tmux"
cp "$T/uni" "$A/Frameworks/Fw.framework/Versions/A/Fw"
cp "$T/x64" "$A/Resources/odd dir/my tool"
cp "$T/a64" "$A/Resources/odd dir/colon:tool"
printf '#!/bin/sh\necho hi\n' > "$A/Resources/run.sh"; chmod +x "$A/Resources/run.sh"
printf 'plain text\n' > "$A/Resources/notes.txt"
ln -s ../Helpers/bun "$A/Resources/bun-link"
want="$A/Frameworks/Fw.framework/Versions/A/Fw
$A/Resources/odd dir/colon:tool
$A/Resources/odd dir/my tool
$A/Helpers/bun
$A/Helpers/tmux"
got="$(bash "$FIND" "$T/Talos.app")"; rc=$?
[ $rc = 0 ] && ok "exit 0" || bad "exit $rc"
[ "$got" = "$want" ] && ok "exactly the binaries, deepest first (universal, single-arch, framework, spaces, colon; no script, text, link or main exe)" || bad "got:
$got
want:
$want"
# the control: the old greedy pipeline on this same bundle
old="$(find "$A" -type f ! -path "$A/MacOS/Talos" -print0 | xargs -0 file -h 2>/dev/null | sed -n 's/^\(.*\): *Mach-O.*/\1/p' | awk -F/ '{print NF "\t" $0}' | sort -rn | cut -f2-)"
[ "$old" != "$want" ] && case "$old" in *"universal binary"*|*"[x86_64"*|*"(for architecture"*) ok "control: the old greedy pattern does get this bundle wrong" ;; *) bad "control: old pattern failed in an unexpected way: $old" ;; esac || bad "control: old pattern passed this bundle, so the test cannot see the bug"
bash "$FIND" "$T/none" >/dev/null 2>&1; [ $? = 64 ] && ok "a missing bundle is a usage error, not an empty list" || bad "missing bundle not refused"
bash "$FIND" >/dev/null 2>&1; [ $? = 64 ] && ok "no argument is a usage error" || bad "no argument accepted"
[ $fail = 0 ] && echo "nested-code-test: all passed" || { echo "nested-code-test: FAILED" >&2; exit 1; }
