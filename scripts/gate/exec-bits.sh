#!/usr/bin/env bash
# exec-bits.sh BASE: refuse a change (BASE..HEAD) that takes the executable bit off a file that had it, unless a commit
# in that range says so in its message with a line `Exec-bit-removed: <path>`.
#
# Why (2026-11-16): an edit made from Windows over \\wsl$ rewrites the file without its x bit, and `git add` recorded that
# as a mode change. It reached main once (spend.py, put back by a4355709) and a builder branch once (install.sh and
# kit/install.sh: every Talos Setup rerun would have failed with "Permission denied"). Tests call these scripts through
# bash or python3, so nothing else notices. Cheap: one `git diff --summary` and one `git log`.
set -euo pipefail
base="${1:?usage: exec-bits.sh BASE}"
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "exec-bits: $base is not a commit" >&2; exit 2; }
dropped="$(git diff --summary "$base" HEAD | sed -n 's/^ mode change 100755 => 100644 //p')"
[ -n "$dropped" ] || exit 0
said="$(git log --format=%B "$base..HEAD" | sed -n 's/^Exec-bit-removed: *//p')"
bad=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if printf '%s\n' "$said" | grep -Fqx -- "$path"; then continue; fi
  echo "exec-bits: $path lost its executable bit (100755 -> 100644) and no commit says so." >&2
  bad=1
done <<<"$dropped"
if [ "$bad" = 1 ]; then
  echo "  Put it back: git update-index --chmod=+x <path> && chmod +x <path>, then amend or add a commit." >&2
  echo "  Meant it? Add a line 'Exec-bit-removed: <path>' to the commit message." >&2
  exit 1
fi
