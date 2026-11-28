#!/bin/bash
# stamp-personal-ok.sh [--repo <dir>] [--remote <name>] <full tip sha>
# Scans merge-base(<remote>/main)..tip with the private list (scripts/check-ref-personal.sh) and, only when that exits 0 with no
# output, pushes an annotated tag to refs/personal-ok/<tip> on the remote (docs/CI-MACHINES.md "personal-ok"; gate-push.sh's
# stamp_ok reads it). Run it on the machine that holds scripts/personal-denylist.txt.
#   --repo    the checkout to work in (default: the repository this script lives in)
#   --remote  the remote to fetch main from and stamp on (default: $REMOTE, else origin)
# The scanner is always check-ref-personal.sh from this script's own folder: there is no way to swap it from the environment.
# It refuses (exit 1) when there is no private list on this machine, or when the range to scan is empty.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote="${REMOTE:-origin}"
tip_arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || { echo "usage: --repo needs a directory"; exit 2; }; repo="$2"; shift 2 ;;
    --remote) [ $# -ge 2 ] || { echo "usage: --remote needs a name"; exit 2; }; remote="$2"; shift 2 ;;
    -*) echo "unknown option: $1"; exit 2 ;;
    *) [ -z "$tip_arg" ] || { echo "one sha only"; exit 2; }; tip_arg="$1"; shift ;;
  esac
done
printf '%s\n' "$tip_arg" | grep -Eqx '[0-9a-f]{40}' || { echo "need a full 40-hex commit sha"; exit 2; }
cd "$repo"
tip="$(git rev-parse --verify -q "$tip_arg^{commit}")" && [ "$tip" = "$tip_arg" ] || { echo "not a commit in this repo: ${tip_arg:0:12}"; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scanner="$here/check-ref-personal.sh"
[ -f "$scanner" ] || { echo "check-ref-personal.sh is missing next to this script: no stamp"; exit 1; }
# The private list, found the way gate-push.sh finds it: next to this script, in the repo's scripts/, or in the main checkout.
list=""
for c in "$here/personal-denylist.txt" "$repo/scripts/personal-denylist.txt"; do
  [ -f "$c" ] && { list="$c"; break; }
done
if [ -z "$list" ]; then
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  [ -z "$common" ] || [ ! -f "$(dirname "$common")/scripts/personal-denylist.txt" ] || list="$(dirname "$common")/scripts/personal-denylist.txt"
fi
[ -n "$list" ] || { echo "no private list here: no stamp"; exit 1; }
# main, fetched into a ref of our own with no tags: "<remote>/main" could be read as a tag of that name
GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags "$remote" '+refs/heads/main:refs/stamp-base/main' </dev/null ||
  { echo "cannot fetch $remote main: no stamp"; exit 1; }
base="$(git merge-base refs/stamp-base/main "$tip")" || { echo "no merge-base with $remote main: no stamp"; exit 1; }
count="$(git rev-list --count "$base..$tip")" || { echo "cannot count the range: no stamp"; exit 1; }
{ [ "$base" != "$tip" ] && [ "$count" != 0 ]; } || { echo "empty range: no stamp"; exit 1; }
rc=0
out="$(CHECK_EXTRA_RULES="$list${CHECK_EXTRA_RULES:+:$CHECK_EXTRA_RULES}" bash "$scanner" "$tip" "$base")" || rc=$?
if [ "$rc" != 0 ]; then
  echo "scan FAILED (rc $rc): no stamp"
  # file:line only, never the matched text: what sits between the leading sha12 and the trailing " [rule]"
  [ -z "$out" ] || printf '%s\n' "$out" | sed -En 's/^[0-9a-f]{12} (.*) \[[^]]*\]$/\1/p'
  exit 1
fi
[ -z "$out" ] || { echo "scan printed lines: no stamp"; exit 1; }
tag="$(printf 'object %s\ntype commit\ntag personal-ok-%s\ntagger Alex Example <alex@example.com> %s +0000\n\npersonal scan PASS (private list) over %s..%s\n' \
  "$tip" "${tip:0:12}" "$(date -u +%s)" "${base:0:12}" "${tip:0:12}" | git mktag)"
git -c core.hooksPath=/dev/null push -q "$remote" "$tag:refs/personal-ok/$tip"
echo "stamped refs/personal-ok/$tip (base ${base:0:9}, $count commits)"
