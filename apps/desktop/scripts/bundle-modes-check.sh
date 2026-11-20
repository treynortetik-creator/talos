#!/usr/bin/env bash
# Refuses a built app bundle with a file its owner cannot write, except the few files that ship read-only ON PURPOSE: the app's own check
# refuses a writable guard hook (WorkerHookSource.swift), and the pinned installer is sealed the same way. Any other read-only file would
# make macOS refuse to clear the download flag on the copy the mover makes ("couldn't clear the download flag"), so it is a build error.
# Usage: bundle-modes-check.sh <Talos.app>
set -u
APP="${1:?usage: bundle-modes-check.sh <Talos.app>}"
[ -d "$APP" ] || { echo "bundle-modes-check: $APP is not a folder" >&2; exit 2; }
ALLOWED=(
  "Contents/Resources/claude-install.sh"
  "Contents/Resources/talos-hooks/permission-relay.py"
  "Contents/Resources/talos-hooks/_talos_common.py"
  "Contents/Resources/talos-hooks/thread-state.py"
  "Contents/Resources/talos-hooks/compaction-guard.py"
)
bad=0
while IFS= read -r f; do
  rel="${f#"$APP"/}"
  ok=0; for a in "${ALLOWED[@]}"; do [ "$rel" = "$a" ] && ok=1; done
  if [ "$ok" = 0 ]; then echo "bundle-modes-check: $rel is not writable by its owner (mode $(stat -f %Lp "$f")); the move to Applications could not clear its download flag" >&2; bad=1; fi
done < <(find "$APP" ! -type l ! -perm -u+w)
exit "$bad"
