#!/usr/bin/env bash
# nested-code.sh <Talos.app>: the paths of the Mach-O files inside the bundle that build-app.sh must sign before the app itself,
# one per line, deepest first (inside-out). The app's own executable (Contents/MacOS/Talos) is left out: the outer signature covers it.
# A file counts when `file -b -h` says "Mach-O" on its first line, so a universal binary is one path (its per-architecture lines are
# never read) and a name with a space or a colon survives, because each file is asked on its own, not parsed out of a joined list.
# Exit 0 listed (possibly nothing), 64 bad arguments.
set -uo pipefail
APP="${1:-}"
[ -n "$APP" ] && [ -d "$APP/Contents" ] || { echo "nested-code: needs a .app folder with a Contents folder" >&2; exit 64; }
while IFS= read -r -d '' f; do
  IFS= read -r kind < <(file -b -h -- "$f" 2>/dev/null) || true
  case "$kind" in Mach-O*) printf '%s\n' "$f" ;; esac
done < <(find "$APP/Contents" -type f ! -path "$APP/Contents/MacOS/Talos" -print0) \
  | awk -F/ '{print NF "\t" $0}' | sort -t "$(printf '\t')" -k1,1nr -k2,2 | cut -f2-
