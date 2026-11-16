#!/usr/bin/env bash
# Removes test folders that runs left directly in $TMPDIR once they are more than a day old; the gate runs it at its start. A run
# removes its own temp folders when it ends (apps/bridge/test/run-tmp.ts, vitest.run-tmp.ts, the e2e stack), so what is left
# is from a run that was killed or crashed, and those added up (one machine's gate $TMPDIR held about 30,000 folders, 7 GB).
# $TMPDIR may be the machine's shared one (macOS's per-user folder, also the live Talos app's), so this is narrow on purpose:
#   - only names that start with a test prefix on the list in scripts/tmp-sweep-prefixes.txt, an allowlist: a folder of any
#     other name, the live app's and a new tool's included, is never touched (scripts/tmp-sweep.test.ts keeps the list complete);
#   - only entries directly in $TMPDIR (nothing deeper is looked at on its own), owned by this user;
#   - only when last modified more than a day ago (find -mtime +0: GNU and BSD find both read it as 24 hours or more);
#   - never a symbolic link (it is left, and so is what it points at), and find never follows one (-P).
# A folder a locked-down test left at mode 000 inside is made writable (owner only, links not followed) and removed. Prints one
# line with the count. Never fails: a sweep that cannot finish must not stop the gate.
set -uo pipefail

list="$(dirname "$0")/tmp-sweep-prefixes.txt"
dir="${TMPDIR:-/tmp}"
dir="$(cd "$dir" 2>/dev/null && pwd -P)" || exit 0
names=()
if [ -f "$list" ]; then
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in *[!A-Za-z0-9._-]* | [!A-Za-z0-9]* | ? | ?? | ???) continue ;; esac # comments, "!" lines, anything odd or short
    case "$l" in *-) ;; *) continue ;; esac
    [ "${#names[@]}" = 0 ] || names+=(-o)
    names+=(-name "$l*")
  done <"$list"
fi
n=0
if [ "${#names[@]}" -gt 0 ]; then
  while IFS= read -r -d '' p; do
    [ -L "$p" ] && continue
    if ! rm -rf -- "$p" 2>/dev/null; then
      /usr/bin/find -P "$p" -type d ! -perm -u=rwx -exec chmod u+rwx {} \; 2>/dev/null
      rm -rf -- "$p" 2>/dev/null
    fi
    [ -e "$p" ] || [ -L "$p" ] || n=$((n + 1))
  done < <(/usr/bin/find -P "$dir" -mindepth 1 -maxdepth 1 ! -type l \( "${names[@]}" \) -user "$(id -u)" -mtime +0 -print0 2>/dev/null)
fi
printf 'gate: removed %s test folders older than a day from %s\n' "$n" "$dir" >&2
exit 0
