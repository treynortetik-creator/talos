#!/usr/bin/env bash
# The lead's zero-token check: main's verdict and the lead inbox, read with gh alone (no Claude), so a scheduled job runs this
# and wakes an agent only on a hit. Needs a gh login that can read the repository; run it from a checkout of main.
#
#   scripts/lead-check.sh     prints one line and writes it to <home>/state (TALOS_LEAD_CHECK_HOME, else ~/.cache/talos-lead-check)
#
# The line: `<UTC time> main=<green|red|pending> sha=<7> failing=<context,...|-> inbox=<N new, R red|unreadable>`.
# main is the newest of main's last 10 first-parent commits whose six local-ci/* contexts are all final; it is red when one
# of them is failure or error. pending: none of the 10 is final yet. The inbox is `lead-inbox.sh unread` without --mark, so
# reading here never moves the reader's mark.
# Exit:
#   0  nothing to do
#   1  a new hit: main is red, or the inbox has new red alerts, and that differs from the last run's line
#   3  the same hit as last run (still red, nothing new): the caller decides whether to wake again
#   2  GitHub could not be read
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ci-runner/gh-account.sh
. "$HERE/ci-runner/gh-account.sh"
REPO="${LEAD_INBOX_REPO:-$(ci_gh_repo "$HERE/.." treynortetik-creator/talos-app)}" # the same as lead-inbox.sh reads
HOME_DIR="${TALOS_LEAD_CHECK_HOME:-$HOME/.cache/talos-lead-check}"
JOBS="browser check desktop image mobile mod"
INBOX="${LEAD_CHECK_INBOX:-bash $HERE/lead-inbox.sh unread}" # a test's seam

fail() { echo "lead-check: cannot read: $*" >&2; exit 2; }

# as the repository owner's account, never gh's active one (scripts/ci-runner/gh-account.sh; CI_GH_USER or GH_TOKEN name another)
errf="$(mktemp "${TMPDIR:-/tmp}/lead-check.XXXXXX")" || fail "no temporary file"
tok="$(ci_gh_token "$REPO" 2>"$errf")" || { why="$(tail -1 "$errf")"; rm -f "$errf"; fail "$why"; }
rm -f "$errf"
export GH_TOKEN="$tok"

shas="$(gh api "repos/$REPO/commits?sha=main&per_page=10" --jq '.[].sha' 2>/dev/null)" || fail "main's commits"
[ -n "$shas" ] || fail "main's commits (none)"
main=pending sha="$(printf '%s\n' "$shas" | head -1)" failing=-
for c in $shas; do
  rows="$(gh api "repos/$REPO/commits/$c/status?per_page=100" \
    --jq '.statuses[] | select(.context | startswith("local-ci/")) | "\(.context | ltrimstr("local-ci/")) \(.state)"' \
    2>/dev/null)" || fail "statuses of $c"
  final=1 bad=""
  for j in $JOBS; do
    st="$(printf '%s\n' "$rows" | awk -v j="$j" '$1 == j {print $2; exit}')"
    case "$st" in
      success) ;;
      failure | error) bad="$bad,$j" ;;
      *) final=0 ;;
    esac
  done
  [ "$final" = 1 ] || continue
  sha="$c"
  if [ -n "$bad" ]; then main=red failing="${bad#,}"; else main=green; fi
  break
done

if out="$($INBOX 2>/dev/null)"; then
  sum="$(printf '%s\n' "$out" | sed -n 's/^lead-inbox: \([0-9]*\) new (\([0-9]*\) red)$/\1 \2/p' | tail -1)"
  n="${sum% *}" r="${sum#* }"
  [ -n "$sum" ] || n=0 r=0
  inbox="$n new, $r red"
else
  inbox=unreadable r=0
fi

line="main=$main sha=${sha:0:7} failing=$failing inbox=$inbox"
mkdir -p "$HOME_DIR"
last="$(cut -d' ' -f2- "$HOME_DIR/state" 2>/dev/null)"
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" | tee "$HOME_DIR/state.part" && mv -f "$HOME_DIR/state.part" "$HOME_DIR/state"

[ "$inbox" = unreadable ] && exit 2
if [ "$main" = red ] || [ "${r:-0}" -gt 0 ]; then
  [ "$line" = "$last" ] && exit 3
  exit 1
fi
exit 0
