#!/usr/bin/env bash
# bundle-modes-check.sh refuses a read-only file nobody meant to be read-only, and passes the intended ones.
set -u
cd "$(dirname "$0")/.."
P=0; F=0; ok(){ echo "ok: $1"; P=$((P+1)); }; bad(){ echo "FAIL: $1"; F=$((F+1)); }
D="$(mktemp -d "${TMPDIR:-/tmp}/talos-modes-XXXXXX")"
A="$D/Talos.app"; mkdir -p "$A/Contents/Resources/talos-hooks" "$A/Contents/MacOS"
for f in Contents/Resources/claude-install.sh Contents/Resources/talos-hooks/permission-relay.py Contents/Resources/talos-hooks/_talos_common.py Contents/Resources/talos-hooks/thread-state.py Contents/Resources/talos-hooks/compaction-guard.py Contents/MacOS/Talos; do echo x > "$A/$f"; done
chmod 0444 "$A/Contents/Resources/claude-install.sh" "$A/Contents/Resources/talos-hooks/"*.py
if bash scripts/bundle-modes-check.sh "$A" 2>/dev/null; then ok "the intended read-only files pass"; else bad "the intended read-only files were refused"; fi
echo x > "$A/Contents/Resources/other.txt"; chmod 0444 "$A/Contents/Resources/other.txt"
OUT="$(bash scripts/bundle-modes-check.sh "$A" 2>&1)"; rc=$?
if [ "$rc" != 0 ] && printf '%s' "$OUT" | grep -q "other.txt"; then ok "a 0444 file outside the list is refused and named"; else bad "a 0444 stray passed (exit $rc)"; fi
chmod 0644 "$A/Contents/Resources/other.txt"; chmod 0444 "$A/Contents/MacOS/Talos"
if bash scripts/bundle-modes-check.sh "$A" 2>/dev/null; then bad "a 0444 executable passed"; else ok "a 0444 executable is refused"; fi
chmod -R u+w "$D"; rm -rf "$D"
echo "$P passed, $F failed"; [ "$F" = 0 ]
