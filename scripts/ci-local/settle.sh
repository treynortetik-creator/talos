# The settle step of ci-local.sh (sourced by it; docs/CI-MACHINES.md, "A main run waits for a quiet head").
# shellcheck shell=bash
# A push run of main (ci-runner.sh sets CI_SETTLE=1 for it, and for no other run) starts, after a ~60-minute run before it, on whatever
# head was newest at that moment, often in the middle of a burst of pushes: by the time it ended, many commits had landed above it.
# So before it takes a slot or a lock or starts a job, it watches origin/main:
#   quiet      main's head is this run's own sha and has stayed so for TALOS_CI_SETTLE_S (300), counted from the push of that head
#              (CI_PUSHED_AT, the push event's own time; else the commit's date), so a head that was already old goes on at once.
#   superseded main's head is another commit: a newer push has its own run waiting (GitHub keeps the newest). This run posts
#              report-ci/superseded on its sha ("not tested:", success: the verdict, the alerts and the green branch read only
#              local-ci/*, and a commit with no local-ci/* status is "no verdict", neither red nor green) and ends with exit 0.
#              The workflow then ends the whole run (its remote parts too) at once, so the group is free for the next one; and a part
#              of that attempt that is still working posts no pass or failure for the sha (ci_stood_aside, below).
#   the cap    a main that never pauses must still be tested. The runs that stand aside one after another are one chain (the file
#              settle-chain in the cache: when its first run stood aside, and its last). Once the chain is TALOS_CI_SETTLE_MAX_S (900)
#              old, by the clock, the run goes on at its own sha, even if main moved. Wall clock, not seconds spent polling: a run
#              that finds main already moved stands aside at its first look and polls for nothing. A chain ends when a run tests,
#              or when its last run stood aside TALOS_CI_SETTLE_STALE_S (6 h) ago.
# Main is read every TALOS_CI_SETTLE_POLL_S (30) seconds (git ls-remote: one cheap call). A read that fails counts as "no change":
# the quiet time and the cap still end the wait.
# Each of the four numbers is set once, here, and read from the environment first (the tests give small ones, ci-runner.sh none).
CI_SETTLE_S="${TALOS_CI_SETTLE_S:-300}" CI_SETTLE_MAX_S="${TALOS_CI_SETTLE_MAX_S:-900}" CI_SETTLE_POLL_S="${TALOS_CI_SETTLE_POLL_S:-30}"
CI_SETTLE_STALE_S="${TALOS_CI_SETTLE_STALE_S:-21600}"

ci_settle_check() { # the numbers are whole seconds (the poll may have a fraction): a bad one stops the run before it does anything
  local n v
  for n in TALOS_CI_SETTLE_S:"$CI_SETTLE_S" TALOS_CI_SETTLE_MAX_S:"$CI_SETTLE_MAX_S" TALOS_CI_SETTLE_STALE_S:"$CI_SETTLE_STALE_S"; do
    v="${n#*:}"
    case "$v" in '' | *[!0-9]* | 0) echo "ci-local: ${n%%:*} is whole seconds >= 1, not '$v'" >&2; return 64 ;; esac
  done
  case "$CI_SETTLE_POLL_S" in '' | .* | *.*.* | *[!0-9.]*) echo "ci-local: TALOS_CI_SETTLE_POLL_S is seconds, not '$CI_SETTLE_POLL_S'" >&2; return 64 ;; esac
  return 0
}

ci_settle_head() { # origin's main now: its full sha, or nothing when it cannot be read (ci_git_net says why on stderr)
  ci_git_net ls-remote origin refs/heads/main 2>/dev/null | awk 'NR == 1 { print $1 }'
}

ci_settle_pushed() { # ci_settle_pushed <sha>: when it was pushed (CI_PUSHED_AT, from the push event), else when its commit was made; or nothing
  local t="${CI_PUSHED_AT:-}"
  case "$t" in '' | *[!0-9]*) t="$(git show -s --format=%ct "$1" 2>/dev/null)" ;; esac
  case "$t" in '' | *[!0-9]*) t="" ;; esac
  printf '%s' "$t"
}

# ci_settle <chain file> <sha>: 0 = go on (quiet, or the cap), 10 = superseded (CI_SETTLE_NEWER is main's head)
ci_settle() {
  local f="$1" sha="$2" now since head quiet_from total s l
  now=$(date +%s) since=$now
  # the chain so far: when it began, unless its last run stood aside long ago (or in the future: a clock that jumped)
  s="" l=""
  [ ! -r "$f" ] || read -r s l < "$f" || true
  case "$s:$l" in
    *[!0-9:]* | :* | *:) ;;
    *) [ "$s" -gt "$now" ] || [ "$l" -gt "$now" ] || [ $((now - l)) -gt "$CI_SETTLE_STALE_S" ] || since=$s ;;
  esac
  # how long the head has been quiet: since its push. A time ahead of the clock counts as now.
  quiet_from="$(ci_settle_pushed "$sha")"
  [ -n "$quiet_from" ] && [ "$quiet_from" -le "$now" ] || quiet_from=$now
  while :; do
    now=$(date +%s) total=$((now - since))
    if [ "$total" -ge "$CI_SETTLE_MAX_S" ]; then
      rm -f "$f"
      echo "ci-local: settle: waited ${total}s since its chain began (TALOS_CI_SETTLE_MAX_S ${CI_SETTLE_MAX_S}s); testing ${sha:0:7} now, whatever main has become"
      return 0
    fi
    head="$(ci_settle_head)"
    if [ -n "$head" ] && [ "$head" != "$sha" ]; then
      printf '%s %s\n' "$since" "$now" > "$f.part" && mv -f "$f.part" "$f" # the next run to stand aside carries on from here
      CI_SETTLE_NEWER="$head"
      return 10
    fi
    if [ $((now - quiet_from)) -ge "$CI_SETTLE_S" ]; then
      rm -f "$f"
      echo "ci-local: settle: main's head ${sha:0:7} has been quiet for $((now - quiet_from))s (TALOS_CI_SETTLE_S ${CI_SETTLE_S}s); going on"
      return 0
    fi
    printf '%s %s\n' "$since" "$now" > "$f.part" && mv -f "$f.part" "$f" # a run stopped from outside leaves its chain as it was
    sleep "$CI_SETTLE_POLL_S"
  done
}

# ci_stood_aside <slug> <sha>: 0 when THIS attempt of the workflow run stood aside for <sha> (its settle step posted report-ci/superseded
# under the attempt's own link, CI_ATTEMPT_URL). The parts of an attempt (Titan's image, Delphi's check, ...) start with the Lemnos job,
# before it has decided, so one that is still working must grade nothing for that commit. GitHub unreadable, or no attempt link: no.
ci_stood_aside() {
  local a="${CI_ATTEMPT_URL:-}" rows
  case "$a" in *'#') ;; *) return 1 ;; esac
  rows="$(ci_statuses "$1" "$2")" || return 1
  printf '%s\n' "$rows" | awk -F'\t' -v a="$a" '$1 == "report-ci/superseded" && index($3, a) == 1 { found = 1 } END { exit !found }'
}
