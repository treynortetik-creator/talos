#!/usr/bin/env bash
# Local CI: runs the same jobs as .github/workflows/ci.yml on this Mac and posts the result to GitHub as commit
# statuses (context `local-ci/<job>`), so a PR shows green or red without spending Actions minutes.
# Added 2026-10-29 when the account ran out of Actions minutes; it stays the default afterwards (ci.yml is now
# manual-only, `gh workflow run CI --ref <branch>` still runs it in the cloud). docs/CI-LOCAL.md has the details.
#
#   scripts/ci-local.sh --pr 39                 # test the PR's head commit
#   scripts/ci-local.sh --ref feat/x            # any branch, tag or sha (pushed or local)
#   env: TALOS_CI_FORCE_DESKTOP=1 (or true/yes/on) runs the desktop job even when no desktop path changed
#        (a commit that is already on origin/main is its own merge-base, so its diff is empty and the gate cannot decide: the desktop
#        and mobile jobs run on it without any flag, on a push, a dispatch or a hand run)
#        CI_SLOTS=3 runs at once · CI_MAX_LOAD=14: a new run waits while the 5-min load average is above it (0 = off)
#        TALOS_CI_CACHE: this dir instead of ~/.cache/talos-ci · TALOS_CI_IMAGE_PORT, TALOS_CI_PW_PORT: slot 1's ports · CI_WORKERS
#   options: --jobs check,mod,browser,image,desktop,mobile (default all) · --latest (also the advisory latest-CLI mod run)
#            --full (no job is skipped for lack of affected files; a run with --jobs or --no-status never skips either)
#            --no-status (don't post to GitHub) · --keep (keep the scratch worktree) · --reap (stop what dead runs left, then exit)
#   env for a run on a shared runner (all optional; docs/CI-LOCAL.md, "On the self-hosted runner"): CI_REPO=owner/name (skip `gh repo view`),
#        CI_STATUS_WHERE (the words in a status, default this machine's own name), CI_STATUS_URL (its link), CI_SHA_FILE (the sha tested,
#        written here), CI_WT_BASE (where scratch worktrees go), CI_SLEEP_GUARD=1 (fail jobs of a run the Mac slept through; default is a warning)
#
# Up to CI_SLOTS runs go at once. Each holds a slot (~/.cache/talos-ci/locks/slot-N) and gets its own scratch worktree,
# temp dir (~/.cache/talos-ci/tmp/talos-ci-sN), Playwright port, image-test port and container, so your checkout is never
# touched and runs never share a port. A step that needs a machine-wide resource that can't be split (the desktop build,
# browser downloads, starting colima) takes a mutex for just that step. A queued run re-resolves the PR head once it has
# its slot, so it never tests a stale commit; statuses go to the commit actually tested. Logs: ~/.cache/talos-ci/logs/.
# Inside a run the install and build happen once, then mod, image and the Swift jobs go beside check, and browser after it.
# Exit 0 only if all passed.
set -uo pipefail

# ---------- locks ----------
# A lock is a directory made with mkdir (the atomic step) holding `owner`: pid, process start time, nonce. Release renames
# the directory away before deleting it, so nobody ever sees a half-removed lock. The rule everything below keeps: only one
# process at a time may believe it holds a lock, however long any of them stalls (load, a stopped process, a sleeping Mac).
#
# A lock whose owner is dead is taken over, never deleted. The waiter makes a claim, `<lock>/takeover-<owner key>.<n>`, then
# re-checks that the owner is still the dead one (the lock may have been released and retaken since it looked) and writes
# itself in. A claim is a symlink whose target names the claimer: `ln -s` is atomic and refuses an existing name, so one
# waiter wins each claim and nobody can see it half-written. A claim is never taken from a live claimer, however old it
# is. Age proves nothing: a claimer stalled past a time limit wakes up and writes, and then two runs hold the slot. When a
# claimer has died, the next waiter makes claim n+1 instead of removing claim n, so nobody ever removes a live claim by
# mistake. The first owner of a lock is written with `ln`, which refuses to replace one, so a creator that stalled past
# CI_LOCK_GRACE loses to the waiter that took over, instead of overwriting it.
CI_SLOTS="${CI_SLOTS:-3}" CI_MAX_LOAD="${CI_MAX_LOAD:-14}"
# The Playwright port of slot N is base + step * (N - 1) (ci_slot_env; TALOS_CI_PW_PORT moves the base). apps/web/playwright.config.ts
# reads these three lines (apps/web/test/helpers/pw-port.ts) and refuses those ports outside a slot run, so a run by hand cannot
# take a port a slot is about to bind. PORT_SLOTS is the most slots the runners are sized for ("Sizing" in docs/CI-LOCAL.md).
CI_PW_PORT_BASE=4873
CI_PW_PORT_STEP=10
CI_PW_PORT_SLOTS=6
CI_POLL="${CI_POLL:-5}" CI_LOCK_TIMEOUT="${CI_LOCK_TIMEOUT:-3600}"
# The time limits of the mobile job's simulator steps (ci_ios_test). They hold the machine-wide `suites` mutex, and a run waiting
# for it gives up after CI_LOCK_TIMEOUT, so the worst case of the steps must stay under it: 4 simctl calls (two listings, two
# shutdowns) and 4 boot waits or test runs (the Busy retry doubles them). 4 x 120 + 4 x 600 = 2880 s, under the 3600 s above.
# scripts/ci-local-runner.test.ts checks the sum against the timeout, so raising a limit without the timeout goes red.
CI_SIMCTL_LIMIT="${CI_SIMCTL_LIMIT:-120}" CI_XCODE_TEST_LIMIT="${CI_XCODE_TEST_LIMIT:-600}"
CI_LOCK_GRACE="${CI_LOCK_GRACE:-30}" # seconds a lock may exist without an owner before a waiter may give it one
CI_NONCE="$$-$RANDOM$RANDOM-$(date +%s)"
CI_HELD="" CI_SLOT="" CI_MARKER=""

# Pinned to C locale and UTC: the same process must print the same start time whoever asks, whatever their TZ or LANG.
ci_proc_start() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }
CI_ME="$$
$(ci_proc_start $$)
$CI_NONCE" # once per process: a ps that fails later must not make a run stop recognising its own lock
ci_me() { printf '%s' "$CI_ME"; }
ci_owner() { cat "$1/owner" 2>/dev/null; }
ci_owner_key() { printf '%s' "$1" | cksum | tr -c '0-9\n' - | head -1; }
ci_stat() { stat -c '%i %Y' "$1" 2>/dev/null || stat -f '%i %m' "$1" 2>/dev/null; } # inode mtime (GNU, then BSD)
ci_owner_alive() { # ci_owner_alive <owner text>
  local pid start now
  pid="$(printf '%s\n' "$1" | sed -n 1p)" start="$(printf '%s\n' "$1" | sed -n 2p)"
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$start" ] || return 0
  now="$(ci_proc_start "$pid")"
  # The pid exists. If ps printed nothing, ps failed (one failed fork on a loaded box): that is not evidence the owner is
  # gone, so it counts as alive. Only a start time that is different says the pid was reused.
  [ -z "$now" ] || [ "$now" = "$start" ]
}
# A job must not outlive its run. Each run keeps a record, $CI_RUNS/<nonce>: its job process groups, its worktree, its container.
# Whoever finds the run gone uses it: the run's own watchdog, and any waiter about to take a lock from it, so a dead run's step
# can never share a slot, a port or a mutex with the next one. A cancelled run does the same for itself.
ci_group_alive() { kill -0 -- "-$1" 2>/dev/null; }
ci_stop_groups() { # ci_stop_groups <file of "pgid start" lines>: INT first (Playwright tears its web server down on INT only)
  local f="$1" g start now live sig tries
  [ -f "$f" ] || return 0
  for sig in INT TERM KILL; do
    live=""
    while read -r g start; do
      [ -n "$g" ] || continue
      # A leader with another start time means that pid was reused, so that group is no longer ours. A leader that is gone
      # with its group still there is ours: a pid can't be reused while a group carries its number.
      now="$(ci_proc_start "$g")"
      [ -z "$now" ] || [ -z "$start" ] || [ "$now" = "$start" ] || continue
      ci_group_alive "$g" || continue
      kill "-$sig" -- "-$g" 2>/dev/null
      live="$live $g"
    done < "$f"
    [ -n "$live" ] || return 0
    tries=20
    [ "$sig" = INT ] && tries=40
    while [ "$tries" -gt 0 ]; do
      for g in $live; do ci_group_alive "$g" && break; g=""; done
      [ -n "$g" ] || return 0
      sleep 0.1
      tries=$((tries - 1))
    done
  done
}
ci_kill_inside() { # ci_kill_inside <dir>: anything still working inside a run's scratch worktree: a detached server, say. The
  # worktree is unique to the run, so this can't reach another run, or a test's fake run, the way a kill by port could.
  local d p
  # An empty path would `cd` to the current directory, and "/" is every process that was started from /: neither is a run's
  # worktree, so neither may ever be a target (a failed mktemp once wrote an empty worktree path into the record).
  [ -n "$1" ] || return 0
  d="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  case "$d" in '' | /) return 0 ;; esac
  lsof -d cwd -Fpn 2>/dev/null | awk -v d="$d" '/^p/ { p = substr($0, 2) }
    /^n/ { n = substr($0, 2); if (n == d || index(n, d "/") == 1) print p }' | while read -r p; do
    [ "$p" = "$$" ] || kill -KILL "$p" 2>/dev/null
  done
}
ci_post_status() { # ci_post_status <slug> <sha> <job> <state> <description> [url]
  local url=()
  [ -z "${6:-}" ] || url=(-f "target_url=$6")
  gh api -X POST "repos/$1/statuses/$2" -f state="$4" -f context="local-ci/$3" -f description="$5" ${url[@]+"${url[@]}"} >/dev/null 2>&1
}
ci_still_ours() { # ci_still_ours <slug> <sha> <job> <url>: 0 if the newest local-ci/<job> status of that commit is still the pending
  # one this run posted (same link). Anything else means someone answered since (the other machine, a newer run): not ours to
  # overwrite with an error. If GitHub can't say, 0: closing a status that might be ours is the safer mistake than leaving it pending.
  local rows ctx state turl
  rows="$(gh api "repos/$1/commits/$2/status?per_page=100" --jq '.statuses[] | [.context, .state, (.target_url // "")] | @tsv' 2>/dev/null)" || return 0
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r ctx state turl; do
    [ "$ctx" = "local-ci/$3" ] || continue
    [ "$state" = pending ] && [ "$turl" = "$4" ]
    return
  done <<ROWS
$rows
ROWS
  return 0
}
ci_settle_run() { # ci_settle_run <record dir>: a run that ends owes GitHub an answer for every pending status it posted, so a
  # cancel, a crash or a kill never leaves one pending for good. Jobs it already reported (marker in reported/) are left alone.
  # The record's `posted` file is moved aside first: the run's own cleanup and its watchdog may both come here, and only one posts.
  local rec="$1" mine slug where url sha job pids=""
  [ -f "$rec/posted" ] || return 0
  mine="$rec/posted.$$"
  mv "$rec/posted" "$mine" 2>/dev/null || return 0
  IFS=$'\t' read -r slug where url < "$mine"
  while IFS=$'\t' read -r sha job; do
    [ -n "$sha" ] && [ -n "$job" ] || continue
    [ ! -e "$rec/reported/$job" ] || continue
    {
      ci_still_ours "$slug" "$sha" "$job" "$url" || exit 0
      ci_post_status "$slug" "$sha" "$job" error "run on $where ended before this job reported (cancelled or interrupted); re-run" "$url"
    } &
    pids="$pids $!"
  done < <(tail -n +2 "$mine")
  [ -z "$pids" ] || wait $pids
  rm -f "$mine"
}
ci_end_run() { # ci_end_run <record dir> [locks dir]: stop everything a run left, then the record goes, so finding no record means
  # nothing left. With a locks dir, the run's locks go too, just before the record: only for a run that is gone or is ending (a
  # waiter taking one lock from a dead run must not release the lock it is taking over, so it passes none).
  local rec="$1" wt
  [ -d "$rec" ] || return 0
  ci_settle_run "$rec" # first, in parallel and quick: a runner gives a cancelled job only seconds
  ci_stop_groups "$rec/groups"
  [ ! -f "$rec/worktree" ] || ci_kill_inside "$(cat "$rec/worktree")"
  [ ! -s "$rec/container" ] || docker rm -f "$(cat "$rec/container")" >/dev/null 2>&1
  [ ! -s "$rec/image" ] || docker image rm -f "$(cat "$rec/image")" >/dev/null 2>&1
  # A colima start that was cut off leaves the VM half up, and the next `colima start` or `docker info` fails on it. The marker
  # is there only while a start is running (docker_up), and a start only happens when Docker was down, so nothing else uses it.
  [ ! -e "$rec/colima-start" ] || colima stop --force >/dev/null 2>&1
  if [ ! -e "$rec/keep" ]; then
    wt="$(cat "$rec/worktree" 2>/dev/null)"
    case "$wt" in */talos-ci-*) rm -rf "${wt:?}" ;; esac
    [ -s "$rec/repo" ] && git -C "$(cat "$rec/repo")" worktree prune >/dev/null 2>&1
  fi
  # The slot's temp dir goes whether or not the worktree is kept, and before the slot is released (below): holding the slot is
  # what makes the directory ours to empty.
  # chmod first: a test that leaves a read-only folder behind (a real kit release is read-only by design) must not jam every
  # later run on this slot.
  [ ! -s "$rec/tmp" ] || case "$(cat "$rec/tmp")" in */talos-ci-s[0-9]*) chmod -R u+w "$(cat "$rec/tmp")" 2>/dev/null; rm -rf "$(cat "$rec/tmp")" ;; esac
  [ -z "${2:-}" ] || [ ! -s "$rec/owner" ] || ci_release_owned "$2" "$(cat "$rec/owner")"
  rm -rf "$rec"
}
ci_release_owned() { # ci_release_owned <locks dir> <owner text>: let go of every lock that owner holds, including the ones its job
  # subshells took (a mutex is taken inside a job, so the run's own list of locks never saw it). Owner text is the run's
  # identity, which a subshell shares; only call it for yourself, or for an owner you know is dead.
  local l gone
  for l in "$1"/*; do
    [ -d "$l" ] && [ "$(ci_owner "$l")" = "$2" ] || continue
    gone="$l.gone.$CI_NONCE.$RANDOM"
    mv "$l" "$gone" 2>/dev/null && rm -rf "$gone"
  done
  return 0
}
ci_reap_dead_runs() { # ci_reap_dead_runs <runs dir> <locks dir>: every run whose process is gone gets stopped, settled and cleaned up
  local rec owner
  for rec in "$1"/*; do
    [ -f "$rec/owner" ] || continue
    owner="$(cat "$rec/owner")"
    ci_owner_alive "$owner" && continue
    ci_end_run "$rec" "$2"
  done
  return 0
}
ci_reap_run() { # ci_reap_run <owner text of a dead run>
  local nonce
  nonce="$(printf '%s\n' "$1" | sed -n 3p)"
  [ -n "${CI_RUNS:-}" ] && [ -n "$nonce" ] && ci_end_run "$CI_RUNS/$nonce"
  return 0
}

ci_write_owner() { # ci_write_owner <lock> <what>: replace a dead owner; only the holder of the takeover claim may call this
  ci_me > "$1.owner.$CI_NONCE" && mv -f "$1.owner.$CI_NONCE" "$1/owner" 2>/dev/null || return 1
  printf '%s\n' "$2" > "$1/what" 2>/dev/null
  return 0
}

ci_new_owner() { # ci_new_owner <lock> <what>: be the first owner; fails if there already is one
  local t="$1.owner.$CI_NONCE" rc=1
  ci_me > "$t" && ln "$t" "$1/owner" 2>/dev/null && rc=0
  rm -f "$t"
  [ "$rc" = 0 ] && printf '%s\n' "$2" > "$1/what" 2>/dev/null
  return $rc
}

ci_claim_marker() { # ci_claim_marker <marker path>: make the takeover claim; 0 = ours, and nobody else can have it while we live
  local m="$1" n=0 st who
  # A claim the old script made is a plain directory, and its holder may be mid-write. Past the grace period it is dead.
  if [ -d "$m" ] && [ ! -L "$m" ]; then
    st="$(ci_stat "$m")" && [ $(($(date +%s) - ${st#* })) -lt "$CI_LOCK_GRACE" ] && return 1
  fi
  while :; do
    if ln -s "$(ci_me)" "$m.$n" 2>/dev/null; then CI_MARKER="$m.$n"; return 0; fi
    who="$(readlink "$m.$n" 2>/dev/null)" || return 1 # the lock is gone, or it was never a claim: the caller tries again
    ci_owner_alive "$who" && return 1                 # someone is on it: leave it to them, however long they take
    n=$((n + 1))                                      # that claimer died; it can't write any more, so the next claim is free
  done
}

ci_lock_takeover() { # ci_lock_takeover <lock> <owner seen> <key> <what>: take over a dead owner's lock; 0 = ours now
  local lock="$1" seen="$2" key="$3" ino rc=1
  ci_claim_marker "$lock/takeover-$key" || return 1 # another waiter is on this takeover, or the lock is gone
  if [ "$(ci_owner "$lock")" = "$seen" ]; then       # else released and retaken since we looked: a live lock, not ours
    ino=""
    [ -z "$seen" ] && { ino="${key#none-}" && ino="${ino%%-*}"; } # ownerless: must still be the same directory
    if [ -z "$ino" ] || [ "$(ci_stat "$lock" | cut -d' ' -f1)" = "$ino" ]; then
      echo "ci-local: took over $(basename "$lock") from a run that is gone (pid $(printf '%s\n' "$seen" | sed -n 1p))" >&2
      [ -z "$seen" ] || ci_reap_run "$seen" # first: nothing of the dead run may still be running when this lock changes hands
      # The claim goes whatever happens next, so a failed write (disk full) never leaves the lock stuck.
      if [ -z "$seen" ]; then
        ci_new_owner "$lock" "$4" # its creator may still wake up: first writer wins, and neither can overwrite the other
      else
        ci_write_owner "$lock" "$4"
      fi && [ "$(ci_owner "$lock")" = "$(ci_me)" ] && rc=0
    fi
  fi
  ci_drop_marker
  return $rc
}

ci_drop_marker() { [ -n "$CI_MARKER" ] && rm -f "$CI_MARKER" 2>/dev/null; CI_MARKER=""; return 0; }

ci_lock_try() { # ci_lock_try <lock> <what>: take the lock now if it is free or its owner is dead; 0 = we hold it
  local lock="$1" what="${2:-}" seen key st
  if mkdir "$lock" 2>/dev/null; then
    if ! ci_new_owner "$lock" "$what"; then
      # Either a waiter took this lock over while we stalled (it is theirs: hands off), or the write failed (disk full): rmdir
      # only removes a lock that is still empty.
      rmdir "$lock" 2>/dev/null
      return 1
    fi
  else
    seen="$(ci_owner "$lock")"
    if [ -n "$seen" ]; then
      ci_owner_alive "$seen" && return 1
      key="$(ci_owner_key "$seen")"
    else
      st="$(ci_stat "$lock")" || return 1 # released meanwhile: the caller tries again
      [ $(($(date +%s) - ${st#* })) -ge "$CI_LOCK_GRACE" ] || return 1
      key="none-${st% *}-${st#* }"
    fi
    ci_lock_takeover "$lock" "$seen" "$key" "$what" || return 1
  fi
  CI_HELD="$CI_HELD$lock"$'\n'
}

ci_lock_release() { # ci_lock_release <lock>: a no-op unless we still own it
  local gone="${1:?}.gone.$CI_NONCE.$RANDOM"
  [ "$(ci_owner "$1")" = "$(ci_me)" ] && mv "$1" "$gone" 2>/dev/null && rm -rf "$gone"
  return 0
}

ci_release_all() {
  local l
  ci_drop_marker # a takeover killed part way: its claim must not outlive us
  while IFS= read -r l; do [ -n "$l" ] && ci_lock_release "$l"; done <<EOF
$CI_HELD
EOF
  CI_HELD=""
}

ci_load5() { # the 5-minute load average, empty if unknown
  if [ -r /proc/loadavg ]; then
    cut -d' ' -f2 /proc/loadavg
  elif sysctl -n vm.loadavg >/dev/null 2>&1; then
    sysctl -n vm.loadavg | tr -d '{}' | awk '{ print $2 }'
  else
    uptime 2>/dev/null | sed 's/.*load average[s]*: *//' | tr -d ',' | awk '{ print $2 }'
  fi
}

ci_load_high() { # 0 when a new run should wait for the machine to calm down
  # A run started by a job of another run (the desktop review tests) already lives inside that run's slot.
  [ "${TALOS_CI_NESTED:-0}" = 1 ] && return 1
  case "$CI_MAX_LOAD" in '' | 0) return 1 ;; esac
  local l
  l="$(ci_load5)"
  [ -n "$l" ] && awk -v l="$l" -v m="$CI_MAX_LOAD" 'BEGIN { exit !(l + 0 > m + 0) }'
}

ci_legacy_busy() { # 0 while a run of the old single-lock script (main) is in flight: it uses <cache>/lock and slot 1's port
  local l="$1/lock" pid st
  [ -d "$l" ] || return 1
  pid="$(cat "$l/pid" 2>/dev/null)"
  case "$pid" in
    '') st="$(ci_stat "$l")" || return 1; [ $(($(date +%s) - ${st#* })) -lt "$CI_LOCK_GRACE" ] ;; # mid-create
    *[!0-9]*) return 1 ;;
    *) kill -0 "$pid" 2>/dev/null ;;
  esac
}

ci_acquire_slot() { # ci_acquire_slot <locks dir> <what>: wait for a calm machine and a free slot; sets CI_SLOT
  local dir="${1:?}" what="$2" deadline state said="" n busy
  deadline=$(($(date +%s) + CI_LOCK_TIMEOUT))
  mkdir -p "$dir"
  while :; do
    rm -rf "$dir"/*.gone.* 2>/dev/null # renamed away by a release that was killed before it deleted them
    if ci_legacy_busy "$(dirname "$dir")"; then
      state="legacy"
      [ "$state" = "$said" ] || echo "ci-local: waiting for a run of the old single-lock script ($(cat "$(dirname "$dir")/lock/what" 2>/dev/null))"
    elif ci_load_high; then
      state="load"
      [ "$state" = "$said" ] || echo "ci-local: waiting: 5-min load average $(ci_load5) is above CI_MAX_LOAD=$CI_MAX_LOAD"
    else
      n=1 busy=""
      while [ "$n" -le "$CI_SLOTS" ]; do
        if ci_lock_try "$dir/slot-$n" "$what"; then CI_SLOT=$n; return 0; fi
        busy="$busy${busy:+, }slot-$n: $(cat "$dir/slot-$n/what" 2>/dev/null)"
        n=$((n + 1))
      done
      state="slots"
      [ "$state" = "$said" ] || echo "ci-local: waiting for a free slot ($busy)"
    fi
    said="$state"
    [ "$(date +%s)" -lt "$deadline" ] || { echo "ci-local: lock timeout (${CI_LOCK_TIMEOUT}s waiting for a slot)" >&2; return 1; }
    sleep "$CI_POLL"
  done
}

ci_mutex() { # ci_mutex <locks dir> <name> <cmd...>: run cmd holding a machine-wide mutex, for a resource a slot can't own
  local lock="$1/mutex-$2" name="$2" deadline said=0 rc
  shift 2
  mkdir -p "$(dirname "$lock")"
  deadline=$(($(date +%s) + CI_LOCK_TIMEOUT))
  until ci_lock_try "$lock" "slot ${CI_SLOT:-?}"; do
    [ "$said" = 1 ] || { echo "ci-local: waiting for the $name mutex ($(cat "$lock/what" 2>/dev/null))"; said=1; }
    [ "$(date +%s)" -lt "$deadline" ] || { echo "ci-local: timed out waiting for the $name mutex" >&2; return 1; }
    sleep "$CI_POLL"
  done
  "$@"
  rc=$?
  ci_lock_release "$lock"
  return $rc
}

ci_wake_epoch() { # when the Mac last woke from sleep, in epoch seconds; fails if it can't say
  local o sec
  o="$(sysctl -n kern.waketime 2>/dev/null)" || return 1
  sec="$(printf '%s\n' "$o" | sed -n 's/^[^0-9]*[{ ] sec = \([0-9][0-9]*\),.*/\1/p' | head -1)"
  [ -n "$sec" ] || return 1
  printf '%s\n' "$sec"
}
ci_slept_since() { # ci_slept_since <epoch>: 0 if the Mac woke from sleep after that moment. A pass from a run it slept through is
  # weaker: a test that waits for something NOT to happen passes across a suspend, and a timeout measured on the wall clock means
  # nothing. Where the wake time can't be read on a Mac, that counts as slept. report() warns on this unless CI_SLEEP_GUARD=1.
  local w
  if w="$(ci_wake_epoch)"; then [ "$w" -gt "$1" ]; else [ "$(uname -s)" = Darwin ]; fi
}

ci_slot_env() { # ci_slot_env <n>: slot n's own ports and temp dir; every fixed port the jobs bind comes from here
  SLOT_PW_PORT=$((${TALOS_CI_PW_PORT:-$CI_PW_PORT_BASE} + ($1 - 1) * CI_PW_PORT_STEP)) # apps/web Playwright webServer (vite preview), PR #49
  SLOT_IMAGE_PORT_BASE=$((${TALOS_CI_IMAGE_PORT:-18080} + ($1 - 1) * 100)) # image test: host port is base + 0..99
  SLOT_TMP="${CI_TMP_BASE:-${TMPDIR:-/tmp}}/talos-ci-s$1"
}

# Workers for the e2e suite (e2e/playwright.config.ts: each test starts its own relay on its own port inside its worker, and the
# relay's auth state is per process, so workers share nothing; the config's default of 1 is for a plain `pnpm test:e2e`). A
# worker is a relay, a bridge and a Chromium: about 3 cores and 6 GB. 3 on a 10-core Mac, which also runs builders and
# a second run beside this one (measured alone there: 1 worker 500 s, 3: 248 s, 5: 187 s). More on a big machine, never more
# than 8 (5 on 18 cores and 128 GB). E2E_WORKERS in the environment wins.
ci_e2e_workers() { # ci_e2e_workers <cores> <memory in GB>
  local by_cpu=$(($1 * 3 / 10)) by_mem=$(($2 / 6)) w
  w=$((by_cpu < by_mem ? by_cpu : by_mem))
  [ "$w" -ge 1 ] || w=1
  [ "$w" -le 8 ] || w=8
  echo "$w"
}
ci_mem_gb() { # whole GB of RAM, empty when it can't be read
  local b k
  if b="$(sysctl -n hw.memsize 2>/dev/null)" && [ -n "$b" ]; then echo $((b / 1073741824))
  elif k="$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' /proc/meminfo 2>/dev/null)" && [ -n "$k" ]; then echo $((k / 1048576)); fi
}
# A simulator for the app's tests, by id (a name can match one iOS runtime, xcodebuild look on another). Booted first; no iPhone: empty.
# The name may hold parentheses ("iPhone SE (3rd generation)"), so the line is read from the end: the last two groups are the id and the state.
ci_ios_sim_dest() {
  [ -z "${TALOS_IOS_SIM:-}" ] || { echo "platform=iOS Simulator,name=$TALOS_IOS_SIM"; return 0; } # a name set by hand wins
  local id; id="$(ci_with_limit "$CI_SIMCTL_LIMIT" xcrun simctl list devices available 2>/dev/null | sed -nE 's/^ +iPhone.* \(([0-9A-F-]{36})\) \((Booted|Shutdown)\).*/\2 \1/p' | sort -s -k1,1 | head -1 | cut -d' ' -f2)"; [ -z "$id" ] || echo "platform=iOS Simulator,id=$id"
}
# ci_with_limit <seconds> <command...>: the command's own exit code; 142 (SIGALRM) when it ran past the limit and was stopped. A
# command, not a shell function (perl execs it). A stopped test run must not hold the machine-wide suites mutex for ever.
ci_with_limit() {
  local secs="$1" rc; shift
  perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$secs" "$@"
  rc=$?
  [ "$rc" != 142 ] || echo "ci-local: stopped after ${secs}s, the time limit (CI_XCODE_TEST_LIMIT for the boot wait and the tests, CI_SIMCTL_LIMIT for the other simulator calls): $*"
  return $rc
}
# ci_ios_test <log> <simulator id or name> <xcodebuild args...>: `xcodebuild ... test` on that simulator, into the log. The simulator
# is booted first and waited for (`simctl bootstatus -b` returns once SpringBoard is up), because xcodebuild launches the app as
# soon as it has booted the device itself, and on a loaded Mac that is too early: 'Busy ("Application failed preflight checks")'
# (ca6ca1c, 2026-11-02: the device cold-booted 17 s before the launch; nothing else was using it). If that exact message still
# comes, the device is made ready again and the run made once more; no other failure is tried again. The device is shut down
# (before the second run, and at the end) only when it was off when we started: another run's or the owner's booted simulator
# is never shut down from here. Every simctl and xcodebuild call has a time limit, so a hung simulator holds the machine-wide
# mutex for at most one limit per call: CI_XCODE_TEST_LIMIT (default 600 s, about eight times the longest whole mobile job seen)
# for the wait and the tests, CI_SIMCTL_LIMIT (default 120 s) for the listing and the shutdowns. A cancel (INT, TERM or HUP) shuts
# down a device that was off at the start too, with one more call on that limit; it is no part of the wait for the mutex.
ci_ios_test() {
  local log="$1" dev="$2" rc was=0 step; shift 2
  step="$(mktemp)"
  ci_ios_booted "$dev" && was=1
  # A cancelled run (ci_stop_groups sends INT, then TERM) puts the device back like a finished one: a simulator this run booted
  # would otherwise stay up for ever. Set once `was` is known, so a device that was already booted is never shut down. bash runs
  # the trap when the call it is waiting for has ended.
  trap 'ci_ios_cancelled "$log" "$dev" "$was" "$step" 130' INT
  trap 'ci_ios_cancelled "$log" "$dev" "$was" "$step" 143' TERM
  trap 'ci_ios_cancelled "$log" "$dev" "$was" "$step" 129' HUP
  ci_ios_ready "$log" "$dev"
  ci_ios_run "$log" "$step" "$@"; rc=$?
  # the file, not a pipe from the log: under pipefail `tail | grep -q` ends the pipe early and reads as a failure on a long log
  if [ "$rc" != 0 ] && grep -qF 'Busy ("Application failed preflight checks")' "$step"; then
    echo "ci-local: the simulator said Busy (application failed preflight checks); trying the tests once more" | tee -a "$log"
    [ "$was" = 1 ] || ci_ios_off "$log" "$dev"
    ci_ios_ready "$log" "$dev"
    ci_ios_run "$log" "$step" "$@"; rc=$?
  fi
  rm -f "$step"
  [ "$was" = 1 ] || ci_ios_off "$log" "$dev"
  trap - INT TERM HUP
  return $rc
}
ci_ios_off() { ci_with_limit "$CI_SIMCTL_LIMIT" xcrun simctl shutdown "$2" >> "$1" 2>&1; } # ci_ios_off <log> <simulator id or name>
ci_ios_cancelled() { # ci_ios_cancelled <log> <simulator> <was booted> <step file> <exit code>: the end of a cancelled ci_ios_test
  trap '' INT TERM HUP # a second signal while the shutdown runs changes nothing
  [ "$3" = 1 ] || ci_ios_off "$1" "$2"
  rm -f "$4"
  exit "$5"
}
# Is the simulator booted now? By id ("(ID)") or by its whole name ("iPhone 17" is not "iPhone 17 Pro"). A listing that fails or
# runs out of time says yes: a device we cannot see is left running, never shut down.
ci_ios_booted() {
  local listing
  listing="$(ci_with_limit "$CI_SIMCTL_LIMIT" xcrun simctl list devices 2>/dev/null)" || return 0
  printf '%s\n' "$listing" | awk -v d="$1" '
    { l = $0; sub(/^ +/, "", l) }
    (index(l, d " (") == 1 || index(l, "(" d ")") > 0) && l ~ /\(Booted\)/ { f = 1 }
    END { exit !f }'
}
ci_ios_ready() { # a device that will not come up is left for xcodebuild to say so
  echo "+ xcrun simctl bootstatus $2 -b" >> "$1"
  ci_with_limit "$CI_XCODE_TEST_LIMIT" xcrun simctl bootstatus "$2" -b >> "$1" 2>&1 || echo "ci-local: the simulator did not report booted (exit $?)" >> "$1"
}
ci_ios_run() { # ci_ios_run <log> <this run's own output file> <command...>: the output goes to both
  local log="$1" out="$2" t rc; shift 2
  echo "+ $*" >> "$log"
  t=$(date +%s)
  ci_with_limit "$CI_XCODE_TEST_LIMIT" "$@" > "$out" 2>&1
  rc=$?
  cat "$out" >> "$log"
  echo "[step] $(($(date +%s) - t))s exit $rc: $*" >> "$log"
  return $rc
}
# The desktop tests find tmux where Rig.tmuxPath looks (Rig.swift: these three paths, version 3.2 or newer, as TmuxPtyHost.isUsable
# asks). Without one they do not fail: every tmux suite is switched off (`.enabled(if: Rig.hasTmux)`), about 130 tests, and the job
# still ends green. So the desktop job checks first and fails when none is usable. CI_TMUX_PATHS is for the tests.
ci_tmux_ok() {
  local p v
  for p in ${CI_TMUX_PATHS:-/opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux}; do
    [ -x "$p" ] || continue
    v="$("$p" -V 2>/dev/null | sed -n 's/^[^0-9]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' | head -1)"
    [ -n "$v" ] || continue
    set -- $v
    if [ "$1" -gt 3 ] || { [ "$1" -eq 3 ] && [ "$2" -ge 2 ]; }; then return 0; fi
  done
  return 1
}
# What a status says it ran on. A machine that names itself (CI_STATUS_WHERE: the runner says ci-runner) says that; otherwise the
# machine's own name, so the owner's hand runs on two Macs are told apart too. A name is clipped and stripped to plain characters
# (it goes into a status description, 140 characters at most). "the owner's Mac" only when no name can be read.
ci_where() {
  local w="${CI_STATUS_WHERE:-}"
  [ -n "$w" ] || w="$(scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || true)"
  w="$(printf '%s' "$w" | tr -c 'A-Za-z0-9._ -' '?' | cut -c1-40)"
  [ -n "$w" ] && printf '%s' "$w" || printf '%s' "the owner's Mac"
}

# Sourced (the tests do this): stop here, with only the functions above defined.
if (return 0 2>/dev/null); then return 0; fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
unset TALOS_CI_CACHE # for this run only: the tests start this script themselves, under a fake HOME, and must not inherit it
mkdir -p "$CACHE/logs"

# The slot temp dir lives beside the slot's lock, under $HOME, because holding the lock is what makes it ours to empty. It
# used to be $TMPDIR/talos-ci-sN: a run under another HOME has other locks and the same $TMPDIR, so every `pnpm test` in a
# builder's checkout (ci-local-slots.test.ts runs this script with a fake HOME) deleted the live temp dir of real slot 1.
# The scratch worktrees go under CI_WT_BASE when set (a runner whose $TMPDIR is wiped between jobs sets it to its cache).
LOCKS="$CACHE/locks" CI_TMP_BASE="$CACHE/tmp" WT_BASE="${CI_WT_BASE:-${TMPDIR:-/tmp}}"
CI_RUNS="$CACHE/runs"
PR="" REF="" JOBS="check,mod,browser,image,desktop,mobile" JOBS_SET=0 FULL=0 LATEST=0 STATUS=1 KEEP=0 REAP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --jobs) JOBS="$2"; JOBS_SET=1; shift 2 ;;
    --full) FULL=1; shift ;;
    --latest) LATEST=1; shift ;;
    --no-status) STATUS=0; shift ;;
    --keep) KEEP=1; shift ;;
    --reap) REAP=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 64 ;;
  esac
done
case "$CI_SLOTS" in '' | *[!0-9]* | 0) echo "ci-local: CI_SLOTS must be a whole number >= 1" >&2; exit 64 ;; esac
if [ "$REAP" = 1 ]; then ci_reap_dead_runs "$CI_RUNS" "$LOCKS"; echo "ci-local: nothing left by dead runs"; exit 0; fi

resolve() { # the commit to test: what the PR's head (or the ref) points at now
  if [ -n "$PR" ]; then
    # Into a ref of our own, never FETCH_HEAD: runs in other slots fetch into this same checkout at the same time.
    local ref="refs/talos-ci/run-$CI_NONCE" sha
    git fetch -q --no-write-fetch-head origin "+refs/pull/$PR/head:$ref" || return 1
    sha="$(git rev-parse --verify "$ref^{commit}")"
    git update-ref -d "$ref"
    [ -n "$sha" ] && echo "$sha"
  else
    git rev-parse --verify "${REF:-HEAD}^{commit}" 2>/dev/null || git rev-parse --verify "origin/$REF^{commit}"
  fi
}
cant_resolve() { if [ -n "$PR" ]; then echo "ci-local: cannot fetch PR $PR" >&2; else echo "ci-local: unknown ref $REF" >&2; fi; }

cd "$ROOT"
git fetch -q origin || true
SHA="$(resolve)" || { cant_resolve; exit 1; }
SLUG="${CI_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
[ -z "$SLUG" ] && STATUS=0
WHERE="$(ci_where)" # what a status says it ran on: the machine's own name (CI_STATUS_WHERE overrides it)
# These are for this script only. Left exported they reach every job: the test suites run ci-local.sh copies of their own (a fake
# repo, a fake gh) and would post to the real repository's commit, write the real CI_SHA_FILE and say "ci-runner". Like TALOS_CI_CACHE
# above they stay readable here and in the subshells, and no child process gets them.
export -n CI_REPO CI_STATUS_WHERE CI_STATUS_URL CI_SHA_FILE CI_WT_BASE CI_SLEEP_GUARD TALOS_CI_FORCE_DESKTOP

post() { # post <job> <state> <description>
  [ "$STATUS" = 1 ] || return 0
  ci_post_status "$SLUG" "$SHA" "$1" "$2" "$3" "${CI_STATUS_URL:-}" || echo "ci-local: could not post status for $1 (continuing)" >&2
}

WT="" CONTAINER="" SLOT_TMP="" RUN_DIR="" WATCHDOG="" RESDIR=""
cleanup() {
  [ -z "$WATCHDOG" ] || kill -KILL "$WATCHDOG" 2>/dev/null # the watchdog ignores INT and TERM, see watch_run
  cd / # this shell's own working directory is the worktree
  # Stops every job that is still going and anything left in the worktree, answers any status still pending, removes the
  # worktree and temp dir (unless --keep), and deletes the record.
  [ -z "$RUN_DIR" ] || ci_end_run "$RUN_DIR" "$LOCKS"
  if [ -n "$WT" ] && [ "$KEEP" = 0 ]; then git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "${WT:?}"; fi
  # With a record, ci_end_run removed the slot's temp dir before it let go of the slot. Doing it again here, after the slot is free,
  # could wipe the live temp dir of the next run that took the slot. Only a run that never made a record has it left.
  [ -z "$SLOT_TMP" ] || [ -n "$RUN_DIR" ] || { chmod -R u+w "${SLOT_TMP:?}" 2>/dev/null; rm -rf "${SLOT_TMP:?}"; }
  # Locks a job took inside its subshell (a mutex) are not in CI_HELD; they are ours all the same, and a cancelled run must not
  # leave one held. Nothing may still be running by now, so this is after the jobs are stopped.
  ci_release_owned "$LOCKS" "$(ci_me)"
  ci_release_all
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ci_reap_dead_runs "$CI_RUNS" "$LOCKS" # whatever a run killed outright left behind, before this one asks for a slot
T_ASKED=$(date +%s)
ci_acquire_slot "$LOCKS" "${SHA:0:7}${PR:+ PR $PR}" || exit 1
export TALOS_CI_NESTED=1

# The run may have queued for a long time: test what the PR (or ref) points at now, and post statuses only for that.
git fetch -q origin || true
NOW="$(resolve)" || { cant_resolve; exit 1; }
if [ "$NOW" != "$SHA" ]; then
  echo "ci-local: ${PR:+PR $PR }head moved while queued (${SHA:0:7} -> ${NOW:0:7}); testing ${NOW:0:7}"
  SHA="$NOW"
  printf '%s\n' "${SHA:0:7}${PR:+ PR $PR}" > "$LOCKS/slot-$CI_SLOT/what"
fi
SHORT="${SHA:0:7}"
[ -z "${CI_SHA_FILE:-}" ] || printf '%s\n' "$SHA" > "$CI_SHA_FILE" # the commit actually tested: whoever sweeps after a cancel needs it

# One run per commit at a time, whatever each one asked for. Two runs of one commit (queued for A, a push, queued for B) used to
# test B together; the later result won on GitHub, so a failure could turn green with no retry anyone asked for, and both
# truncated one log. A run that had to wait takes over the first one's result for each job it also ran, as long as both were
# asked to run the same way: --latest, posting or not, a forced desktop job and GUI tests all change what a green means.
# Every other job it tests itself, without touching what the first one posted. If the first died, there is nothing to reuse.
# A run that finds no one ahead always tests fresh.
ci_flag() { case "$(printf '%s' "${1:-0}" | tr '[:upper:]' '[:lower:]')" in 1 | true | yes | on) echo 1 ;; *) echo 0 ;; esac; }
SETTINGS="$(ci_owner_key "$LATEST $STATUS $(ci_flag "${TALOS_CI_FORCE_DESKTOP:-0}") $(ci_flag "${TALOS_GUI_TESTS:-0}")")"
SHALOCK="$LOCKS/sha-$SHA" RESDIR="$CACHE/results/$SHA-$SETTINGS"
mkdir -p "$CACHE/results" && find "$CACHE/results" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null
WAITED=0 SHADEADLINE=$(($(date +%s) + CI_LOCK_TIMEOUT))
until ci_lock_try "$SHALOCK" "slot $CI_SLOT"; do
  [ "$WAITED" = 1 ] || echo "ci-local: $SHORT is already being tested ($(cat "$SHALOCK/what" 2>/dev/null)); waiting for that result"
  WAITED=1
  [ "$(date +%s)" -lt "$SHADEADLINE" ] || { echo "ci-local: timed out waiting for the run testing $SHORT" >&2; exit 1; }
  sleep "$CI_POLL"
done
IFS=',' read -r -a WANT <<< "$JOBS"
BAD_BEFORE=""
if [ "$WAITED" = 1 ]; then
  LEFT=()
  for j in "${WANT[@]}"; do
    case "$(cat "$RESDIR/$j" 2>/dev/null)" in
      '') LEFT+=("$j") ;;
      skip) [ "$FULL" = 0 ] || LEFT+=("$j") ;; # --full skips nothing, so a skipped job is not an answer to it
      0) ;;
      *) case " $BAD_BEFORE " in *" $j "*) ;; *) BAD_BEFORE="${BAD_BEFORE:+$BAD_BEFORE }$j" ;; esac ;;
    esac
  done
  if [ ${#LEFT[@]} -eq 0 ]; then
    [ -z "$BAD_BEFORE" ] && { echo "ci-local: all green ($SHORT): the run that tested it first passed; statuses are already posted"; exit 0; }
    echo "ci-local: FAILED ($SHORT): the run that tested it first failed ($BAD_BEFORE); statuses are already posted"
    exit 1
  fi
  [ ${#LEFT[@]} -eq ${#WANT[@]} ] || echo "ci-local: taking the first run's result for the jobs it tested; testing ${LEFT[*]}"
  WANT=("${LEFT[@]}")
else
  rm -rf "$RESDIR"
fi
mkdir -p "$RESDIR"

# Jobs this commit cannot affect are not run. scripts/ci-affected.sh compares the commit with the last GREEN commit (not just its
# parent: the inner commits of a push get no status) and names the jobs the difference can reach. The rest are answered at once as
# success, "skipped: no affected files", which ci_classify (ci-runner.sh) reads as no failure and never as a pass. Only a run that
# runs every job by default and posts its answers does this: --jobs names exactly what to run, --full runs all, and a run that
# posts nothing has nowhere to say a job was skipped. A run with TALOS_GUI_TESTS or TALOS_CI_FORCE_DESKTOP set, and a rerun of a
# commit that already has statuses, run every job. Anything unsure (no green base, GitHub unreadable, the script missing, an
# unknown path) runs the job. SKIP_UNAFFECTED is the `why` that report() turns into that exact description.
SKIP_UNAFFECTED="no affected files" SKIP_JOBS=()
plan_skips() {
  local out affected j keep=() skip=() f
  [ "$FULL" = 0 ] && [ "$JOBS_SET" = 0 ] && [ "$STATUS" = 1 ] && [ -f "$ROOT/scripts/ci-affected.sh" ] || return 0
  # The GUI desktop tests read apps/web (the companion harness and the theme tokens), so a run that asks for them, or forces
  # the desktop job, skips nothing.
  [ "$(ci_flag "${TALOS_GUI_TESTS:-0}")" = 0 ] && [ "$(ci_flag "${TALOS_CI_FORCE_DESKTOP:-0}")" = 0 ] || return 0
  # Up to 30 sequential gh calls while this run holds a slot: a hung one is stopped after CI_PLAN_LIMIT (120 s) and every job runs.
  # Into a file, not a pipe: a gh left running by the stop would hold a pipe open, and the substitution would wait for it.
  f="$(mktemp)" || return 0
  ci_with_limit "${CI_PLAN_LIMIT:-120}" bash "$ROOT/scripts/ci-affected.sh" plan "$SLUG" "$SHA" > "$f" 2>/dev/null || : > "$f"
  out="$(cat "$f")"
  rm -f "$f"
  affected="$(printf '%s\n' "$out" | sed -n 1p)"
  case " $affected " in *" check "*) ;; *) echo "ci-local: could not tell which jobs the change affects; running every job"; return 0 ;; esac
  echo "ci-local: $(printf '%s\n' "$out" | sed -n 2p)"
  for j in "${WANT[@]}"; do
    case " $affected " in *" $j "*) keep+=("$j") ;; *) skip+=("$j") ;; esac
  done
  [ ${#keep[@]} -gt 0 ] || return 0 # nothing left to run (the first run of this commit did it): leave the list alone
  WANT=("${keep[@]}")
  SKIP_JOBS=(${skip[@]+"${skip[@]}"})
}
plan_skips

T_SLOT=$(date +%s)
ci_slot_env "$CI_SLOT"
{ chmod -R u+w "${SLOT_TMP:?}" 2>/dev/null; rm -rf "${SLOT_TMP:?}"; } && mkdir -p "$SLOT_TMP" || exit 1 # anything here was left by a run that died in this slot
export PW_PORT="$SLOT_PW_PORT" TMPDIR="$SLOT_TMP"
export TALOS_CI_SLOT_RUN=1 # beside PW_PORT: apps/web/playwright.config.ts accepts a slot port only with this
unset TALOS_CI_PW_PORT TALOS_CI_IMAGE_PORT # same reason as TALOS_CI_CACHE: used, and gone before any test sees them

# This run's record and results. They are per run, not per slot: nothing that outlives this run can write into the next one's.
RUN_DIR="$CI_RUNS/$CI_NONCE"
mkdir -p "$RUN_DIR" || exit 1
WT="$(mktemp -d "$WT_BASE/talos-ci-$SHORT.XXXX")" && [ -n "$WT" ] || { echo "ci-local: cannot make a scratch worktree under '$WT_BASE'" >&2; WT=""; exit 1; }
# The record says everything needed to clean up after this run, so the watchdog, a waiter and the next run can do it without us.
printf '%s\n' "$WT" > "$RUN_DIR/worktree"
ci_me > "$RUN_DIR/owner"
printf '%s\n' "$ROOT" > "$RUN_DIR/repo"
printf '%s\n' "$SLOT_TMP" > "$RUN_DIR/tmp"
[ "$KEEP" = 0 ] || : > "$RUN_DIR/keep"
git worktree add -q --detach "$WT" "$SHA" || exit 1

# If this shell is killed outright, no cleanup runs and jobs in groups of their own would carry on. So the watchdog, in a group of
# its own, does the cleanup instead. `kill -9` of the run, or of its process group, doesn't reach it.
# It ignores INT and TERM: a runner cancelling a job signals the step's own process (INT, then TERM, then KILL), and at the end of the
# job it kills whatever still carries the job's tracking id; the watchdog is the one that must outlive both signals. When the run is gone it does all the run's own cleanup would have: stops the jobs, answers pending statuses, removes the
# worktree and temp dir, and lets go of the run's locks (the slot, the commit, any mutex a job held).
watch_run() {
  trap '' INT TERM HUP
  while kill -0 "$1" 2>/dev/null; do sleep 1; done
  ci_end_run "$RUN_DIR" "$LOCKS"
}
set -m
( cd / && watch_run "$$" ) </dev/null >/dev/null 2>&1 &
WATCHDOG=$!
set +m

if [ "$STATUS" = 1 ]; then # written before the first post: whoever ends this run owes an answer for each of these
  { printf '%s\t%s\t%s\n' "$SLUG" "$WHERE" "${CI_STATUS_URL:-}"; for j in "${WANT[@]}"; do printf '%s\t%s\n' "$SHA" "$j"; done; } > "$RUN_DIR/posted"
fi
for j in "${WANT[@]}"; do post "$j" pending "running on $WHERE"; done

run() { # run <log> <cmd...>: echo the step, append its output to the log, then how long it took
  local log="$1" t rc; shift
  kill -0 "$$" 2>/dev/null || return 1 # the run is gone (in a job, $$ is the run's shell): no more steps
  echo "+ $*" >> "$log"
  t=$(date +%s)
  "$@" >> "$log" 2>&1
  rc=$?
  echo "[step] $(($(date +%s) - t))s exit $rc: $*" >> "$log"
  return $rc
}

warn_step() { # warn_step <job> <log> <what it means> <cmd...>: a step that warns. A failure reaches the log and the job's result
  # line and status (report), and the job goes on.
  local j="$1" log="$2" what="$3" rc=0; shift 3
  run "$log" "$@" || rc=$?
  [ "$rc" = 0 ] || echo "warning: $what (exit $rc: $*)" | tee -a "$log" >> "$RESULTS/$j.warn"
  return 0
}

together() { # together <log> <fn...>: the steps side by side, each into its own file, added to the log whole when all end.
  # Steps that failed go last, so the reason is in the tail a failed job prints.
  local log="$1" f p pairs="" ok="" bad=""; shift
  for f in "$@"; do
    run "$log.$f" "$f" &
    pairs="$pairs $f:$!"
  done
  for p in $pairs; do
    if wait "${p##*:}"; then ok="$ok ${p%%:*}"; else bad="$bad ${p%%:*}"; fi
  done
  for f in $ok $bad; do cat "$log.$f" >> "$log"; rm -f "$log.$f"; done
  [ -z "$bad" ]
}

wants() { # wants <job...>: 0 if this run has any of them
  local a b
  for a in "$@"; do for b in "${WANT[@]}"; do [ "$a" = "$b" ] && return 0; done; done
  return 1
}

# Once per run, before the jobs: they all use one node_modules and one apps/web/dist + apps/relay/dist, and two jobs must
# not install or build into them at the same time. So the browser job's suites are told not to build (SKIP_BUILD,
# E2E_SKIP_BUILD; the bundles are the ones `pnpm build` made, byte for byte).
SETUP_LOG="$CACHE/logs/$SHORT-setup.log" SETUP_FAILED=""
setup_run() {
  : > "$SETUP_LOG"
  wants check browser mobile || return 0
  run "$SETUP_LOG" pnpm install --frozen-lockfile || { SETUP_FAILED="pnpm install"; return 1; }
  run "$SETUP_LOG" pnpm build || SETUP_FAILED="pnpm build"
}
setup_ok() { # a job's first step: a failed install or build fails every job that needed it, with the reason in its log
  [ -n "$SETUP_FAILED" ] || return 0
  { echo "setup failed: $SETUP_FAILED"; tail -40 "$SETUP_LOG"; } >> "$1"
  return 1
}

wait_for_job() { # wait_for_job <job> [marker]: until that job of this run has finished or left <marker>; at once if it isn't in the run
  wants "$1" || return 0
  until [ -f "$RESULTS/$1" ] || { [ -n "${2:-}" ] && [ -f "$RESULTS/$2" ]; } ||
    ! kill -0 "$(cat "$RESULTS/$1.group" 2>/dev/null)" 2>/dev/null; do sleep 1; done
}

job_tmp() { # job_tmp <name>: a temp dir of the job's own inside the slot's, removed with it
  mkdir -p "$SLOT_TMP/$1" && export TMPDIR="$SLOT_TMP/$1"
}

# How many workers Vitest and the bun runner may each start: 40% of the cores (4 on this Mac). Vitest's own default is cores
# - 1, for a suite that has the machine to itself; these two now overlap. docs/CI-LOCAL.md has the measurements.
CI_CPUS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)"
CI_WORKERS="${CI_WORKERS:-$((CI_CPUS * 2 / 5 > 2 ? CI_CPUS * 2 / 5 : 2))}"
# The quiet group's bridge schedules files: one process per file, each in its own temp home with its own Chronos and no fixed port,
# and nothing else of the run is going, so a third of the cores (6 here) instead of the 40% above shared by three suites.
CI_SCHED_JOBS="${CI_SCHED_JOBS:-$((CI_CPUS / 3 > 2 ? CI_CPUS / 3 : 2))}"
CI_MEM_GB="$(ci_mem_gb)" # unreadable: 0, which ci_e2e_workers turns into 1 worker, never a guess upward

step_vitest() { pnpm test --maxWorkers="$CI_WORKERS"; }
# The two halves of the bridge suite (test-parallel.ts). A commit forked before that runner existed has only the plain one, so
# the first half does nothing and the second runs all of it.
BUN_RUNNER=apps/bridge/scripts/test-parallel.ts SLOW_PREFIX=test/schedules/
step_bun_schedules() { [ ! -f "$BUN_RUNNER" ] || bun run "$BUN_RUNNER" --jobs "$CI_SCHED_JOBS" --only "$SLOW_PREFIX"; }
step_bun_rest() {
  if [ -f "$BUN_RUNNER" ]; then bun run "$BUN_RUNNER" --jobs "$CI_WORKERS" --skip "$SLOW_PREFIX"; else pnpm test:bun; fi
}
step_contract() { pnpm --filter @talos-app/bridge test:contract; }
step_capture() { bun run apps/bridge/scripts/capture-schedules.ts --check; }

# One thing at a time where a test waits on real time. The contract suite and the schedules tests give a real bridge and the real
# Chronos CLI 3 seconds to answer, and every way of running them beside anything else failed on some run (docs/CI-LOCAL.md has
# the list). So each group, and each Swift job, holds the `suites` mutex: one at a time on this Mac, across all runs.
quiet_suites() {
  run "$1" step_contract && run "$1" step_bun_schedules
  local rc=$?
  : > "$RESULTS/quiet-done"
  return $rc
}
loud_suites() { together "$1" step_bun_rest step_vitest step_capture; }

job_check() {
  local log="$1"
  setup_ok "$log" &&
  job_tmp check &&
  warn_step check "$log" "personal data found (a warning by default)" pnpm check:personal &&
  run "$log" pnpm typecheck &&
  run "$log" pnpm typecheck:mod &&
  run "$log" pnpm lint &&
  run "$log" pnpm notices:check &&
  suites_then_audit "$log"
}

# The suites decide the job. The audit always runs after them and only warns: an advisory, or the registry being down, says
# nothing about this commit's code, and a red test must not hide an advisory. It looks at high and critical advisories only.
suites_then_audit() {
  local log="$1" rc=0
  { run "$log" ci_mutex "$LOCKS" suites quiet_suites "$log" &&
    run "$log" ci_mutex "$LOCKS" suites loud_suites "$log"; } || rc=1
  warn_step check "$log" "a high or critical advisory, or the registry did not answer" pnpm audit --prod --audit-level high
  return "$rc"
}

claude_at() { # claude_at <version> <args...>: the local CLI when it is that version, else a throwaway npm copy
  local v="$1"; shift
  local home; home="$(mktemp -d)"
  if [ "$v" != latest ] && [ "$(claude --version 2>/dev/null | cut -d' ' -f1)" = "$v" ]; then
    HOME="$home" claude "$@"
  else
    # npm cache per slot: two `npm exec` installs into one cache's _npx folder at once can clobber each other
    HOME="$home" npm_config_cache="$CACHE/npm-s$CI_SLOT" npm exec --yes --package="@anthropic-ai/claude-code@$v" -- claude "$@"
  fi
}

job_mod() {
  local log="$1" v
  v="$(tr -d '[:space:]' < plugins/talos-app-mod/CLAUDE_CODE_VERSION)"
  run "$log" claude_at "$v" plugin validate plugins/talos-app-mod &&
  run "$log" claude_at "$v" plugin test plugins/talos-app-mod || return 1
  if [ "$LATEST" = 1 ]; then
    { run "$log" claude_at latest plugin validate plugins/talos-app-mod && run "$log" claude_at latest plugin test plugins/talos-app-mod; } \
      || echo "(advisory) latest CLI failed; not counted" >> "$log"
  fi
}

# The browser job's microphone check (scripts/mic-preflight.mjs): Chromium's getUserMedia sometimes never answers on the CI Mac (a stuck
# audio device), and then the voice specs time out one by one, 20 of them. Stuck, or the check not running at all, fails the job
# with one plain line in the log and in the status (RESULTS/browser.why, read by report), after the tests have run. Never green.
mic_preflight() { # mic_preflight <log>
  local log="$1" out rc line
  echo "+ node scripts/mic-preflight.mjs" >> "$log"
  out="$(node scripts/mic-preflight.mjs 2>>"$log")"; rc=$? # stderr (a Node warning) goes to the log, not into the answer
  printf '%s\n' "$out" >> "$log"
  out="$(printf '%s\n' "$out" | tail -1)"
  [ "$rc" = 0 ] && [ "$out" = ok ] && return 0
  if [ "$rc" = 3 ]; then
    line="the runner's microphone is blocked (getUserMedia never answers): check the Mac's microphone permission, then rerun"
  else
    line="the microphone preflight could not run (exit $rc: $(printf '%s' "$out" | head -1 | cut -c1-60)); see the log"
  fi
  echo "ci-local: $line" >> "$log"
  printf '%s\n' "$line" > "$RESULTS/browser.why"
  return 1
}

job_browser() {
  local log="$1" mic=0
  # PW_PORT is this slot's own web preview port (exported above), so neither a builder's ad-hoc Playwright run on the
  # default 4173 nor a run in another slot can collide with it. The e2e suite and the relay specs pick free ports.
  # After the check job, not beside it: the e2e suite has the same 3-second waits on real processes, and the web specs want the
  # CPU. That costs the most time of anything in this script, and every overlap tried failed on some run (docs/CI-LOCAL.md).
  # E2E_SKIP_BUILD and SKIP_BUILD: setup already built what they serve. The e2e config reads E2E_WORKERS.
  setup_ok "$log" &&
  job_tmp browser &&
  wait_for_job check &&
  run "$log" ci_mutex "$LOCKS" playwright-install pnpm exec playwright install chromium webkit && # one shared browser cache
  { mic_preflight "$log" || mic=1; true; } &&
  export SKIP_BUILD=1 E2E_SKIP_BUILD=1 E2E_WORKERS="${E2E_WORKERS:-$(ci_e2e_workers "$CI_CPUS" "${CI_MEM_GB:-0}")}" &&
  {
    # One failing part never hides the next: the protocol browser suite, then every e2e package (--no-bail, so a web
    # failure does not stop the relay or e2e package after it). The job fails if any part did.
    local other=0 e2e=0
    run "$log" pnpm test:browser || other=1
    run "$log" pnpm -r --workspace-concurrency=1 --no-bail --if-present test:e2e || e2e=1
    if [ "$mic" = 1 ]; then
      # A stuck microphone fails the job with the plain line (browser.why) while the other tests still run. The web voice
      # specs always fail then, so only the protocol browser suite, which never opens the microphone, counts as "other":
      # a failure there is named, since it can't be the audio.
      [ "$other" = 1 ] && printf '%s\n' "$(head -1 "$RESULTS/browser.why" | cut -c1-90); other tests failed too, see the log" > "$RESULTS/browser.why"
      return 1
    fi
    [ "$other$e2e" = 00 ]
  }
}

docker_up() {
  docker info >/dev/null 2>&1 && return 0
  if command -v colima >/dev/null 2>&1; then
    # The marker stays only if this is cut off part way (a cancelled run): ci_end_run then stops the half-started VM.
    [ -z "$RUN_DIR" ] || : > "$RUN_DIR/colima-start"
    # The runner kills every process that carries its job's RUNNER_TRACKING_ID when the job ends (its log: "Terminate orphan
    # process ... (colima)"). The VM's daemon must outlive this run: Docker is the owner's too. So it starts without the id.
    env -u RUNNER_TRACKING_ID colima start >/dev/null 2>&1
    [ -z "$RUN_DIR" ] || rm -f "$RUN_DIR/colima-start"
  fi
  for i in $(seq 1 30); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

job_image() {
  local log="$1" key port image="talos-relay:ci-$SHORT-s$CI_SLOT"
  printf '%s\n' "$image" > "$RUN_DIR/image" # so a cancel during the build or the run can remove it
  ci_mutex "$LOCKS" docker docker_up >> "$log" 2>&1 || { echo "docker is not running (colima start failed)" >> "$log"; return 1; }
  # From the commit, not the worktree: the other jobs are writing into the worktree while this one sends it to Docker.
  run "$log" bash -c 'set -o pipefail; git archive "$1" | docker build -f apps/relay/Dockerfile -t "$2" -' _ "$SHA" "$image" || return 1
  key="$(openssl rand -base64 32)"
  port=$((SLOT_IMAGE_PORT_BASE + RANDOM % 100))
  run "$log" docker run -d --name "$CONTAINER" -p "$port:8080" \
    -e NODE_ENV=production -e PUBLIC_ORIGIN=https://relay.example.com -e RP_ID=relay.example.com \
    -e DATA_KEY="$key" -e VAPID_PUBLIC_KEY=pub -e VAPID_PRIVATE_KEY=priv -e VAPID_SUBJECT=mailto:owner@example.com \
    "$image" || return 1
  for i in $(seq 1 30); do curl -fsS "localhost:$port/healthz" >/dev/null 2>&1 && break; sleep 1; done
  local ok=0
  run "$log" curl -fsS "localhost:$port/healthz" &&
  curl -fsS "localhost:$port/" | grep -q '<div id="root">' &&
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Test-Session: none' "localhost:$port/api/me")" = 401 ] &&
  docker exec "$CONTAINER" sh -c 'grep -q "^Uid:\s*10001" /proc/1/status' || ok=1
  docker logs "$CONTAINER" >> "$log" 2>&1
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  docker image rm "$image" >/dev/null 2>&1
  return $ok
}

# The Mac app (apps/desktop, SwiftPM + Command Line Tools, no Xcode). On a machine without Swift it skips with a clear
# message and counts as passed: a Linux box or a fresh checkout without the toolchain must not block the JS jobs.
SKIPPED=() SKIP_WHY="swift is not installed"
job_desktop() {
  local log="$1"
  if ! command -v swift >/dev/null 2>&1; then
    echo "SKIPPED: swift is not installed on this machine, so the desktop app was not built or tested" | tee -a "$log"
    SKIPPED+=(desktop)
    return 0
  fi
  # Path gating (fails closed): only the gate's explicit exit 1 skips. Exit 0, an error (2), a failed merge-base or a
  # missing gate script all run the job. TALOS_CI_FORCE_DESKTOP=1|true|yes|on forces a run (kept for
  # apps/desktop/scripts/review-d0-test.sh and the ci-local tests, which use it as their control; ci-local.sh does not export it).
  local base rc=2 force="${TALOS_CI_FORCE_DESKTOP:-0}"
  base="$(git merge-base origin/main "$SHA" 2>/dev/null)" || base=""
  # A commit already on origin/main is its own merge-base: the diff is empty, so "no changes" would be a lie about code nobody
  # tested. The gate cannot decide there, so the job runs (a push to main, a dispatch of a main commit, a hand run).
  [ "$base" != "$SHA" ] || { base=""; echo "desktop gate: $SHORT is already on origin/main, nothing to diff against; running the job" >> "$log"; }
  # The gate runs from OUR copy ($ROOT, the checkout running ci-local), never from the PR's tree: a PR forked before the
  # gate existed has none, and a PR must not be able to edit its own gate. It diffs in the cwd, which is the worktree.
  if [ -n "$base" ]; then bash "$ROOT/scripts/ci-desktop-gate.sh" "$base" "$SHA"; rc=$?; fi
  case "$(printf '%s' "$force" | tr '[:upper:]' '[:lower:]')" in 1|true|yes|on) rc=0 ;; esac
  if [ "$rc" = 1 ]; then
    echo "skipped (no desktop changes)" | tee -a "$log"
    SKIPPED+=(desktop); SKIP_WHY="no desktop changes"
    return 0
  fi
  if [ ! -f apps/desktop/scripts/ci.sh ]; then   # a commit forked before the desktop app existed
    echo "skipped (commit has no desktop app)" | tee -a "$log"
    SKIPPED+=(desktop); SKIP_WHY="commit has no desktop app"
    return 0
  fi
  [ "$rc" = 0 ] || echo "desktop gate could not decide (exit $rc); running the desktop job" >> "$log"
  if ! ci_tmux_ok; then
    echo "FAILED: no usable tmux (3.2 or newer) at /opt/homebrew/bin, /usr/local/bin or /usr/bin on this machine. The desktop tests would skip every tmux suite (about 130 tests: tmux hosting, the worker manager, the OC3 reviews) and still end green. Install tmux (brew install tmux) and re-run." | tee -a "$log"
    return 1
  fi
  mkdir -p "$CACHE/swiftpm"
  # Window-opening integration tests run only when the architect sets TALOS_GUI_TESTS=1 in a logged-in session; it is
  # passed through, never set here (Chronos and headless runs must not open windows).
  # TALOS_SIGN_ID=- : CI apps are always ad-hoc signed, so CI never touches the login keychain or the owner's identity key.
  # The shared SwiftPM scratch (incremental builds), the GUI session and the review tests' keychains are one per Mac,
  # so the desktop job holds a mutex: one desktop build at a time, whatever the slots.
  TALOS_SIGN_ID=- TALOS_GUI_TESTS="${TALOS_GUI_TESTS:-0}" TALOS_SWIFTPM_CACHE="$CACHE/swiftpm" TALOS_SWIFT_SCRATCH="$CACHE/desktop-build" \
    run "$log" ci_mutex "$LOCKS" desktop bash apps/desktop/scripts/ci.sh "$WT/.desktop-out"
}

# The iPhone shell (apps/mobile; IOS-SPEC section 7). Runs only when the diff touches apps/mobile, the native bridge
# schema, the TypeScript half of the push seal (the Swift tests read its vectors) or this script (fails closed: an unknown merge-base runs it, and so does a commit already on origin/main). Needs Swift; builds for the simulator when Xcode is
# present, unsigned, with DerivedData in the scratch worktree (deleted with it).
ci_xcode_ok() { local t; for t in ${CI_XCODE_TOOLS:-xcodegen xcodebuild}; do command -v "$t" >/dev/null 2>&1 || return 1; done; }
job_mobile() {
  local log="$1" base
  if ! command -v swift >/dev/null 2>&1; then
    echo "SKIPPED: swift is not installed on this machine" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="swift is not installed"
    return 0
  fi
  base="$(git merge-base origin/main "$SHA" 2>/dev/null)" || base=""
  # A commit already on origin/main is its own merge-base: an empty diff is not "no mobile changes", so the job runs.
  [ "$base" != "$SHA" ] || base=""
  if [ -n "$base" ] && git diff --quiet --no-renames "$base" "$SHA" -- \
      apps/mobile/ packages/protocol/src/native.ts scripts/native-fixtures.ts scripts/ci-local.sh \
      packages/protocol/src/push-rich.ts packages/protocol/src/push.ts packages/protocol/fixtures/push-rich; then
    echo "skipped (no mobile changes)" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="no mobile changes"
    return 0
  fi
  [ -d apps/mobile/ios/App ] || { echo "skipped (commit has no iPhone shell)" | tee -a "$log"; SKIPPED+=(mobile); SKIP_WHY="commit has no iPhone shell"; return 0; }
  setup_ok "$log" &&
  run "$log" pnpm --filter @talos-app/mobile typecheck &&
  run "$log" pnpm --filter @talos-app/mobile test || return 1
  mkdir -p "$CACHE/swiftpm"
  local pkg
  for pkg in BridgeGuard TalosAudioCore TalosCrashCore TalosPushCore; do
    run "$log" bash -c "cd apps/mobile/ios/$pkg && swift test --cache-path '$CACHE/swiftpm'" || return 1
  done
  run "$log" env TALOS_SWIFTPM_CACHE="$CACHE/swiftpm" bash apps/mobile/ios/TalosShareCore/test.sh || return 1
  if ci_xcode_ok; then
    # A dummy relay: the generated capacitor.config.json is gitignored and only has to exist for the build.
    TALOS_RELAY_URL=https://relay.example.com run "$log" pnpm --filter @talos-app/mobile cap:sync &&
    run "$log" pnpm --filter @talos-app/mobile check:generated &&
    run "$log" git diff --exit-code -- apps/mobile/ios ':!apps/mobile/ios/App/CapApp-SPM/Package.swift' &&
    run "$log" xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath "$WT/.dd" CODE_SIGNING_ALLOWED=NO build || return 1
    # The tests that run inside the app (AppTests: the real Keychain, sign-out). They need a simulator; none is a failure.
    local dest; dest="$(ci_ios_sim_dest)"
    [ -n "$dest" ] || { echo "FAILED: no iPhone simulator is installed, so the app's own tests (AppTests) did not run. Install one in Xcode or set TALOS_IOS_SIM." | tee -a "$log"; return 1; }
    ci_ios_test "$log" "${dest##*=}" xcodebuild -project apps/mobile/ios/App/App.xcodeproj -scheme App -destination "$dest" -derivedDataPath "$WT/.dd" test || return 1
  else
    # Never a pass: the generated-project check and the simulator build are the point of this job. On a Mac it is a failure
    # (the runner lacks a tool); elsewhere the job is recorded as skipped, which no verdict counts as passed.
    if [ "$(uname -s)" = Darwin ]; then
      echo "FAILED: xcodegen or xcodebuild is not on PATH, so the generated project and the simulator build were not checked. Install xcodegen (brew install xcodegen) and Xcode, and re-run." | tee -a "$log"
      return 1
    fi
    echo "skipped (xcodegen or xcodebuild is not installed; the generated-project check and the simulator build did not run)" | tee -a "$log"
    SKIPPED+=(mobile); SKIP_WHY="xcodegen or xcodebuild is not installed"
  fi
}

cd "$WT"
echo "ci-local: $SHORT ${PR:+(PR $PR) }slot $CI_SLOT/$CI_SLOTS, jobs: $JOBS"
setup_run
T_SETUP=$(date +%s)

RESULTS="$RUN_DIR/results"
mkdir -p "$RESULTS"
run_job() { # run_job <job>: one job start to finish; leaves "<exit code> <seconds> <why it skipped>" in $RESULTS/<job>
  local j="$1" log="$CACHE/logs/$SHORT-$j.log" start rc=1 why=""
  : > "$log"
  start=$(date +%s)
  if declare -F "job_$j" >/dev/null; then "job_$j" "$log"; rc=$?; fi
  [[ " ${SKIPPED[*]:-} " == *" $j "* ]] && why="$SKIP_WHY"
  printf '%s %s %s\n' "$rc" "$(($(date +%s) - start))" "$why" > "$RESULTS/$j.part"
  mv -f "$RESULTS/$j.part" "$RESULTS/$j"
}
start_jobs() { # start_jobs <job...>: these jobs, one after another, as one background group of processes of their own
  local j
  set -m # each background group gets its own process group, so a cancelled run can stop all of it
  (
    set +m
    # Only this shell posts statuses. A job (install scripts, test code, a browser) gets no way to: a pass it could post by hand
    # for any commit of the repository would be a pass nobody tested.
    unset GH_TOKEN GITHUB_TOKEN
    for j in "$@"; do
      case "$j" in
        desktop | mobile) # a build wants every core: after this run's quiet suites, and never beside anyone's
          wait_for_job check quiet-done
          ci_mutex "$LOCKS" suites run_job "$j" ;;
        *) run_job "$j" ;;
      esac
    done
  ) </dev/null &
  set +m
  printf '%s %s\n' "$!" "$(ci_proc_start $!)" >> "$RUN_DIR/groups"
  for j in "$@"; do echo "$!" > "$RESULTS/$j.group"; done
}
report() { # report <job> <exit code> <seconds> <why it skipped>
  local j="$1" rc="$2" secs="$3" why="${4:-}" log="$CACHE/logs/$SHORT-$1.log" slept=0 woke warned=""
  # A job that "passed" while the Mac slept gets a warning: see ci_slept_since. CI_SLEEP_GUARD=1 makes it a failure instead.
  # Skips don't depend on the Mac being awake.
  if [ "$rc" = 0 ] && [ -z "$why" ] && ci_slept_since "$T_SLOT"; then
    woke="the Mac slept during this run (last wake $(ci_wake_epoch 2>/dev/null || echo unknown), run began $T_SLOT)"
    case "${CI_SLEEP_GUARD:-0}" in
      1 | on | yes | true) echo "$woke; a pass cannot be trusted. Re-run." >> "$log"; rc=1 slept=1 ;;
      *) echo "warning: $woke" | tee -a "$log" >> "$RESULTS/$j.warn" ;;
    esac
  fi
  # For a run of this commit waiting behind this one. A skip is stored as "skip", not 0: it is a pass for a run that may skip, and
  # no answer at all for a --full run, which skips nothing (see the wait above).
  if [ "$rc" = 0 ] && [ -n "$why" ]; then echo skip > "$RESDIR/$j"; else printf '%s\n' "$rc" > "$RESDIR/$j"; fi
  if [ "$slept" = 1 ]; then
    echo "  ✗ $j (${secs}s): the Mac slept during the run; not trusted, re-run"; post "$j" error "the Mac slept during the run; result not trusted, re-run"
    FAILED+=("$j")
  elif [ "$rc" != 0 ]; then
    echo "  ✗ $j (${secs}s), log: $log"; tail -25 "$log" | sed 's/^/    /'
    if [ -s "$RESULTS/$j.why" ]; then post "$j" failure "$(head -1 "$RESULTS/$j.why" | cut -c1-140)"
    else post "$j" failure "failed on $WHERE; see ~/.cache/talos-ci/logs/$SHORT-$j.log"; fi
    FAILED+=("$j")
  elif [ -n "$why" ]; then
    echo "  - $j skipped: $why (${secs}s)"
    if [ "$why" = "$SKIP_UNAFFECTED" ]; then post "$j" success "skipped: $why"; else post "$j" success "skipped ($why)"; fi
  else
    if [ -s "$RESULTS/$j.warn" ]; then warned=", with warnings (see its log)"; sed 's/^/  ! /' "$RESULTS/$j.warn"; fi
    echo "  ✓ $j (${secs}s)"; post "$j" success "passed on $WHERE in ${secs}s$warned"
  fi
  mkdir -p "$RUN_DIR/reported" && : > "$RUN_DIR/reported/$j" # answered: a later cancel has nothing to settle for this job
}

for j in ${SKIP_JOBS[@]+"${SKIP_JOBS[@]}"}; do report "$j" 0 0 "$SKIP_UNAFFECTED"; done

# Every job at once (the browser job waits for check, see job_browser), except the two Swift jobs: they share a SwiftPM cache and a
# build of them wants every core, so the iPhone shell waits for the Mac app.
UNIQUE="" SWIFT=()
for j in "${WANT[@]}"; do
  case " $UNIQUE " in *" $j "*) continue ;; esac
  UNIQUE="$UNIQUE $j"
  case "$j" in
    desktop | mobile) SWIFT+=("$j") ;;
    image) CONTAINER="talos-ci-s$CI_SLOT-$SHORT-$$"; printf '%s\n' "$CONTAINER" > "$RUN_DIR/container"; start_jobs "$j" ;;
    *) start_jobs "$j" ;;
  esac
done
[ ${#SWIFT[@]} -eq 0 ] || start_jobs "${SWIFT[@]}"

# Results as they come. A job that died without leaving one (killed from outside) is a failure, never a pass.
FAILED=() WAITING="$UNIQUE"
while [ -n "${WAITING// /}" ]; do
  STILL=""
  for j in $WAITING; do
    if [ -f "$RESULTS/$j" ] || ! kill -0 "$(cat "$RESULTS/$j.group")" 2>/dev/null; then
      if [ -f "$RESULTS/$j" ]; then
        read -r rc secs why < "$RESULTS/$j"
        report "$j" "$rc" "$secs" "$why"
      else
        echo "the job died without a result" >> "$CACHE/logs/$SHORT-$j.log"
        report "$j" 1 "$(($(date +%s) - T_SETUP))"
      fi
    else
      STILL="$STILL $j"
    fi
  done
  WAITING="$STILL"
  [ -z "${WAITING// /}" ] || sleep 1
done

T_DONE=$(date +%s)
echo "ci-local: timing: waited $((T_SLOT - T_ASKED))s, setup $((T_SETUP - T_SLOT))s, jobs $((T_DONE - T_SETUP))s"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$SHORT" "$CI_SLOT" "$JOBS" \
  "$((T_SLOT - T_ASKED))" "$((T_SETUP - T_SLOT))" "$((T_DONE - T_SETUP))" "${#FAILED[@]}" >> "$CACHE/logs/timings.tsv"
[ ${#FAILED[@]} -eq 0 ] && [ -z "$BAD_BEFORE" ] && { echo "ci-local: all green ($SHORT)"; exit 0; }
echo "ci-local: FAILED: ${BAD_BEFORE:+$BAD_BEFORE }${FAILED[*]:-} ($SHORT)"; exit 1
