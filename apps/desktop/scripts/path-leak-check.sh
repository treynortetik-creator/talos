#!/usr/bin/env bash
# Refuses a built app that carries the builder's paths: $HOME, "/Users/" (any case), or the checkout's absolute path, in ANY file of
# it (binaries, Info.plist, hooks, scripts): a file it cannot read fails the check, never passes it.
# Usage: path-leak-check.sh <app or folder or file> [checkout path]   exit 0 clean, 1 found, 2 a file could not be read, 64 bad use.
# Reads raw bytes with grep -a: `strings` skips the linker's debug-map names (the symbol table), which is where these paths sit.
# Prints a count and a file name only, never the matched text (it holds a user name).
set -uo pipefail
TARGET="${1:-}"; CHECKOUT="${2:-}"
[ -n "$TARGET" ] && [ -e "$TARGET" ] || { echo "path-leak-check: usage: path-leak-check.sh <app, folder or file> [checkout path]" >&2; exit 64; }
PATTERNS=("/Users/")
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] && PATTERNS+=("$HOME")
[ -n "$CHECKOUT" ] && [ "$CHECKOUT" != "/" ] && PATTERNS+=("$CHECKOUT")
total=0; first=""
while IFS= read -r -d '' f; do
  n=0
  for p in "${PATTERNS[@]}"; do
    hits="$(LC_ALL=C grep -a -o -i -F -e "$p" -- "$f" 2>/dev/null)"; rc=$?
    [ "$rc" -le 1 ] || { echo "path-leak-check: could not read ${f#"$TARGET"/}; nothing is known clean" >&2; exit 2; }
    [ -z "$hits" ] || n=$((n + $(printf '%s\n' "$hits" | wc -l | tr -d ' ')))
  done
  if [ "$n" -gt 0 ]; then total=$((total + n)); [ -n "$first" ] || first="$f"; fi
done < <(find "$TARGET" -type f -print0)
if [ "$total" -gt 0 ]; then
  echo "path-leak-check: $total build path(s) of this Mac (a home folder or the checkout) are inside the built app, first in ${first#"$TARGET"/}; it would leak the builder's user name" >&2
  exit 1
fi
exit 0
