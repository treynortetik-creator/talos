#!/usr/bin/env bash
# Tests bundle-tools.sh with no network: a mirror folder stands in for the downloads. A download that does not match its pin is
# refused (exit 9) and leaves no output folder and no cache entry; a file missing from the mirror is a failure, not a pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d "${TMPDIR:-/tmp}/talos-tools-test-XXXXXX")"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/mirror" "$T/cache"
export TALOS_TOOLS_CACHE="$T/cache" TALOS_TOOLS_MIRROR="$T/mirror"

echo "not the real zip" > "$T/mirror/bun-darwin-aarch64-1.4.4.zip"
TALOS_TOOLS_ONLY=bun bash "$HERE/scripts/bundle-tools.sh" --out "$T/out" --arch arm64 >"$T/log" 2>&1; rc=$?
[ "$rc" = 9 ] && ok "a download that does not match its pin is refused (exit 9)" || bad "wrong exit $rc: $(cat "$T/log")"
grep -q "does not match its pinned sha256" "$T/log" && ok "and says so" || bad "no mismatch line: $(cat "$T/log")"
[ ! -e "$T/out" ] && ok "nothing is left in the output folder" || bad "the output folder exists"
[ -z "$(ls -A "$T/cache")" ] && ok "a bad download is not kept in the cache" || bad "the cache holds: $(ls "$T/cache")"

rm -f "$T/mirror/"*
TALOS_TOOLS_ONLY=bun bash "$HERE/scripts/bundle-tools.sh" --out "$T/out" --arch arm64 >"$T/log" 2>&1; rc=$?
[ "$rc" != 0 ] && [ ! -e "$T/out" ] && ok "a file missing from the mirror fails and bundles nothing" || bad "missing file exit $rc, out exists: $([ -e "$T/out" ] && echo yes)"

# a cached file that no longer matches is not trusted: it is fetched again (here: from the bad mirror) and refused
echo "tampered" > "$T/cache/bun-darwin-aarch64-1.4.4.zip"
echo "also wrong" > "$T/mirror/bun-darwin-aarch64-1.4.4.zip"
TALOS_TOOLS_ONLY=bun bash "$HERE/scripts/bundle-tools.sh" --out "$T/out" --arch arm64 >"$T/log" 2>&1; rc=$?
[ "$rc" = 9 ] && ok "a tampered cache entry is not trusted" || bad "tampered cache exit $rc"

# the Claude Code installer script is pinned too
rm -rf "$T/cache" "$T/out"; mkdir -p "$T/cache"; rm -f "$T/mirror/"*
echo "a different script" > "$T/mirror/claude-install-2c5506d110560bf618bbe88f678f2c2a0047c86a9c6585fc84976120b1de0b44.sh"
TALOS_TOOLS_ONLY=claude bash "$HERE/scripts/bundle-tools.sh" --out "$T/out" --arch arm64 >"$T/log" 2>&1; rc=$?
[ "$rc" = 9 ] && [ ! -e "$T/out" ] && ok "a changed Claude Code installer script is refused" || bad "claude pin exit $rc"

bash "$HERE/scripts/bundle-tools.sh" --arch sparc >/dev/null 2>&1; [ $? = 64 ] && ok "bad arguments exit 64" || bad "bad arguments"
[ "$fail" = 0 ] && echo "bundle-tools-test.sh: green" || exit 1
