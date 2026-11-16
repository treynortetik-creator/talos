#!/usr/bin/env bash
# Tests path-leak-check.sh on fixtures, no build: a Mach-O copy with a fake /Users path (refused), the same with the checkout path
# (refused), a clean Mach-O (passes), a text file that holds a path (refused), another case, an unreadable file, and that the message never prints the path.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/path-leak-check.sh"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
U="/Us""ers"   # split so this file holds no home-folder path itself (guards-test.sh)
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mk() { # mk <dir> <extra bytes>: a real Mach-O (a copy of /bin/echo, one slice) with text appended
  mkdir -p "$1/Talos.app/Contents/MacOS"; cp /bin/echo "$1/Talos.app/Contents/MacOS/Talos"
  [ -z "${2:-}" ] || printf '\0%s\0' "$2" >> "$1/Talos.app/Contents/MacOS/Talos"
}
mk "$T/clean"
mk "$T/user" "$U/someone/x/apps/desktop/.build/Objects/a.o"
mk "$T/home" "/home/alex/stuff"
mk "$T/checkout" "/opt/work/talos/apps/desktop/Sources/A.swift"
mk "$T/textonly"; printf '%s/someone/x\n' "$U" > "$T/textonly/Talos.app/Contents/notes.txt"

bash "$CHECK" "$T/clean" /opt/work/talos >/dev/null 2>&1 && ok "clean app passes" || bad "clean app refused"
out="$(bash "$CHECK" "$T/user" 2>&1)"; rc=$?
[ $rc = 1 ] && ok "a /Users path is refused (exit 1)" || bad "a /Users path got exit $rc"
case "$out" in *someone*|*"$U/"*) bad "message prints the matched text" ;; *"Contents/MacOS/Talos"*) ok "message names the file, not the text" ;; *) bad "message does not name the file: $out" ;; esac
HOME=/home/alex bash "$CHECK" "$T/home" >/dev/null 2>&1; [ $? = 1 ] && ok "\$HOME is refused" || bad "\$HOME not refused"
bash "$CHECK" "$T/checkout" /opt/work/talos >/dev/null 2>&1; [ $? = 1 ] && ok "the checkout path is refused" || bad "checkout path not refused"
bash "$CHECK" "$T/checkout" /opt/other >/dev/null 2>&1; [ $? = 0 ] && ok "another checkout path is not flagged" || bad "false positive on checkout"
bash "$CHECK" "$T/textonly" >/dev/null 2>&1; [ $? = 1 ] && ok "a path in a text file of the bundle is refused too" || bad "text file not flagged"
mk "$T/case"; printf '\0%s\0' "/users/someone/x" >> "$T/case/Talos.app/Contents/MacOS/Talos"
bash "$CHECK" "$T/case" >/dev/null 2>&1; [ $? = 1 ] && ok "a path in another case is refused" || bad "other-case path passed"
mk "$T/unread"; chmod 000 "$T/unread/Talos.app/Contents/MacOS/Talos"
bash "$CHECK" "$T/unread" >/dev/null 2>&1; rc=$?; chmod 644 "$T/unread/Talos.app/Contents/MacOS/Talos"
[ $rc = 2 ] && ok "an unreadable file fails the check (exit 2)" || bad "unreadable file gave exit $rc"
bash "$CHECK" "$T/none" >/dev/null 2>&1; [ $? = 64 ] && ok "a missing target is a usage error, not a pass" || bad "missing target passed"
[ $fail = 0 ] && echo "path-leak-test: all passed" || { echo "path-leak-test: FAILED" >&2; exit 1; }
