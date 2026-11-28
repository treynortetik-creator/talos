# scripts/ci-local/locks.sh: locks, run records, status posting and settling, reaping, slots, the suites mutex. Part of scripts/ci-local.sh, which sources it in place. Not run on its own.
# A process's start time, the token apps/bridge/src/proc-identity.ts prints. Linux: /proc/<pid>/stat field 22 with the boot id, never ps (WSL's ps prints a start time that drifts by seconds, and a live owner then looked like a reused pid); the fields
# are counted after the last `)` because the command may hold spaces. Elsewhere: ps, pinned to C locale and UTC so the same
# process prints the same start time whoever asks. Nothing printed means no answer, which never proves "gone"; nor does a
# token against a start time an older script wrote with ps (ci_comparable).
ci_proc_start() {
  if [ -r /proc/self/stat ]; then
    local s b IFS=$' \t\n'
    s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
    b="$(tr -dc '0-9a-fA-F' < /proc/sys/kernel/random/boot_id 2>/dev/null | cut -c1-12)"
    s="${s##*)}"
    # shellcheck disable=SC2086 # split on purpose: one word per field, field 3 first
    set -- $s
    [ "$#" -ge 20 ] && [ -n "$b" ] && printf 'linux:%s:%s\n' "$b" "${20}"
    return 0
  fi
  LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'
}
ci_comparable() { # ci_comparable <start> <start>: both /proc tokens or both ps text (comparableStarts in proc-identity.ts)
  case "$1" in linux:*) case "$2" in linux:*) return 0 ;; *) return 1 ;; esac ;; esac
  case "$2" in linux:*) return 1 ;; esac
}
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
  [ -z "$now" ] || ! ci_comparable "$now" "$start" || [ "$now" = "$start" ]
}
# A job must not outlive its run. Each run keeps a record, $CI_RUNS/<nonce>: its job process groups, its worktree, its container.
# Whoever finds the run gone uses it: the run's own watchdog, and any waiter about to take a lock from it, so a dead run's step
# can never share a slot, a port or a mutex with the next one. A cancelled run does the same for itself.
ci_group_alive() { kill -0 -- "-$1" 2>/dev/null; }
ci_stop_groups() { # ci_stop_groups <file of "pgid start" lines> [own]: INT first (Playwright tears its web server down on INT only)
  # Which groups are this run's is decided once, before the first signal (the INT ends a leader; its group still goes on to TERM
  # and KILL). A group whose recorded leader is alive with the start time it had is the run's. A group whose leader is gone
  # counts only for the run itself at its own end (own: its cleanup or its watchdog), which made those groups minutes ago and
  # stops what its jobs left behind. Reaping ANOTHER run that is gone, such a group may carry a number reused since (the whole
  # group ended, and a newer one, the owner's even, got the number and lost its own leader): it is left running and said on
  # stderr, a leak, never a kill. A leader that is there with another start time, or a /proc token against ps text an older
  # script wrote, is never the run's (silently).
  local f="$1" own="${2:-}" g start now live sig tries mine=""
  [ -f "$f" ] || return 0
  while read -r g start; do
    [ -n "$g" ] || continue
    ci_group_alive "$g" || continue
    now="$(ci_proc_start "$g")"
    if [ -n "$now" ]; then
      if [ -z "$start" ]; then [ -z "$own" ] || mine="$mine $g" # recorded when ps failed: only the run itself may vouch for it
      elif ci_comparable "$now" "$start" && [ "$now" = "$start" ]; then mine="$mine $g"; fi
    elif kill -0 "$g" 2>/dev/null; then
      echo "${CI_MSG:-ci-local}: left group $g running: its leader's start time could not be read" >&2
    elif [ -n "$own" ]; then
      mine="$mine $g"
    else
      echo "${CI_MSG:-ci-local}: left group $g running: its leader is gone, so it can't be shown to be that run's" >&2
    fi
  done < "$f"
  [ -n "$mine" ] || return 0
  for sig in INT TERM KILL; do
    live=""
    for g in $mine; do
      ci_group_alive "$g" || continue
      kill "-$sig" -- "-$g" 2>/dev/null
      live="$live $g"
    done
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
# The status context of a job: <CI_STATUS_PREFIX>/<job>. local-ci/ (the default) is the six the verdict reads; ci-part/ is a part of
# check run on another machine (docs/CI-MACHINES.md), folded into local-ci/check; report-ci/ is report-only (the fast lane is
# always report-ci/fast). An argument that is already a context (it has a slash, from a run's record) is used as it is.
ci_context() {
  case "$1" in
    */*) echo "$1" ;;
    fast) ci_ns report-ci/fast ;;
    *) ci_ns "${CI_STATUS_PREFIX:-local-ci}/$1" ;;
  esac
}
# The nightly (CI_NIGHTLY=1: ci-runner.sh sets it for a schedule run) posts under nightly-ci/ only, never over a commit's
# local-ci/* or report-ci/*: a push run's verdict on a commit is final (docs/CI-MACHINES.md, "The nightly's own contexts").
# local-ci/<job> is nightly-ci/<job>, ci-part/<part> nightly-ci/part-<part>, report-ci/<job> nightly-ci/report-<job>. The same
# function is in ci-runner.sh (scripts/ci-runner.test.ts checks that the two agree). The hostile nightly (CI_HOSTILE=1) is the
# same under hostile-ci/ (docs/CI-MACHINES.md, "The hostile nightly").
ci_ns() {
  local ns=nightly-ci
  if [ "${CI_HOSTILE:-}" = 1 ]; then ns=hostile-ci; elif [ "${CI_NIGHTLY:-}" != 1 ]; then printf '%s\n' "$1"; return 0; fi
  case "$1" in
    local-ci/*) printf '%s/%s\n' "$ns" "${1#local-ci/}" ;;
    ci-part/*) printf '%s/part-%s\n' "$ns" "${1#ci-part/}" ;;
    report-ci/*) printf '%s/report-%s\n' "$ns" "${1#report-ci/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
# Two answers for one context (docs/CI-MACHINES.md): when several machines of one workflow attempt may answer the same context, a
# red from any of them stays red. CI_ATTEMPT_URL is the attempt's link prefix ("<run>/attempts/<n>#"); each job's own link
# (CI_STATUS_URL) starts with it. Without it (one machine, as today) none of this reads anything.
# ci_attempt_rows <slug> <sha> <context> <attempt>: "state<TAB>description" of every status of that context posted by this
# attempt, newest first, from the commit's full status list (the combined status keeps only the newest per context, and a
# pending posted on top would hide a red under it).
ci_attempt_rows() { # exit 1 when GitHub could not be read: the caller decides what "unknown" means for it, never "no red"
  # Another machine's `error` (its own link, not this run's CI_STATUS_URL) is left out: a machine that was stopped (cancelled,
  # timed out, its runner stopped) closes its pending as error on its way out, which is no answer, so a take-over of the job
  # runs and its result stands. A `failure` from any machine is kept (a red stays red), and so is this run's own plain error.
  # An error that says "not tested:" (a cancelled run, ci_settle_list) is no answer from anyone, this run included.
  local all
  [ -n "$4" ] || return 0
  all="$(ci_statuses "$1" "$2")" || return 1
  printf '%s\n' "$all" | ci_attempt_filter "$3" "$4" "${5:-}"
}
ci_statuses() { # ci_statuses <slug> <sha>: the commit's every status, "context<TAB>state<TAB>link<TAB>description"; one read
  gh api --paginate "repos/$1/commits/$2/statuses?per_page=100" \
    --jq '.[] | [.context, .state, (.target_url // ""), (.description // "")] | @tsv' 2>/dev/null
}
ci_attempt_filter() { # ci_attempt_filter <context> <attempt> [own] < ci_statuses: ci_attempt_rows's rows, from a list already read
  # $3: whose error to keep instead of this run's (parts_poll reads a part machine's own refusal)
  awk -F'\t' -v c="$1" -v a="$2" -v own="${3:-${CI_STATUS_URL:-}}" \
    '$1 == c && index($3, a) == 1 && !($2 == "error" && $3 != own) && index($4, "not tested:") != 1 { print $2 "\t" $4 }'
}
ci_attempt_red() { awk -F'\t' '$1 == "failure" { d = $2 } END { if (d != "") print d }'; } # the first red's words (oldest)
ci_attempt_final() { awk -F'\t' '$1 == "success" || $1 == "failure" || $1 == "error" { print $1; exit }'; }
ci_post_status() { # ci_post_status <slug> <sha> <job> <state> <description> [url]
  # A post that fails says so on stderr (the job log), with why. It does not fail the run: a lost final post leaves its pending,
  # which sweep (or the next run's settle) closes as an error: no verdict, never a wrong green.
  local url=() ctx err rc why st="$4" desc="$5"
  ctx="$(ci_context "$3")"
  [ -z "${6:-}" ] || url=(-f "target_url=$6")
  if ! command -v gh >/dev/null 2>&1; then echo "ci-local: status not posted: $ctx (no gh on PATH)" >&2; return 1; fi
  # An attempt that stood aside (its settle step marked the commit report-ci/superseded) grades nothing: a part of it that is still
  # working (Titan's image, under local-ci/) must not post a pass or a failure for a commit CI chose not to test, which a verdict
  # would read, red included. Its answer is an error that says "not tested:", which no verdict reads as red or green.
  case "$st:$ctx" in success:local-ci/* | failure:local-ci/*)
    ! ci_stood_aside "$1" "$2" || { st=error desc="not tested: superseded by a newer push (settle); nothing is graded for this commit"; } ;;
  esac
  err="$(gh api -X POST "repos/$1/statuses/$2" -f state="$st" -f context="$ctx" -f description="$desc" ${url[@]+"${url[@]}"} 2>&1 >/dev/null)"
  rc=$?
  # A transport failure (an empty reply, a 5xx, a timeout, a reset) gets exactly ONE more try: the call is retried, never the test.
  # A 4xx or a validation error is not retried; the second failure is the caller's to report (ci-local.sh post: ::error::).
  if [ "$rc" != 0 ] && ci_post_transport_failure "$err"; then
    echo "ci-local: status post for $ctx failed in transit (gh exit $rc: $(printf '%s' "$err" | head -1 | cut -c1-120)); retrying once" >&2
    sleep "${CI_POST_RETRY_SLEEP:-2}"
    err="$(gh api -X POST "repos/$1/statuses/$2" -f state="$st" -f context="$ctx" -f description="$desc" ${url[@]+"${url[@]}"} 2>&1 >/dev/null)"
    rc=$?
  fi
  if [ "$rc" = 0 ]; then
    # A final answer GitHub took is written down for the sweep that ends a workflow job (ci-runner.sh sweep): its read of the
    # commit's statuses can lag this post, and must not close what this run already answered. CI_SHA_FILE is in RUNNER_TEMP,
    # one per job; a hand run has none. Commit, context and link, all three: settling a dead run's status (another link) or a
    # late watchdog of an earlier job on this runner must never hide this run's own pending from the sweep.
    [ "$st" = pending ] || [ -z "${CI_SHA_FILE:-}" ] || printf '%s\t%s\t%s\n' "$2" "$ctx" "${6:-}" >> "${CI_SHA_FILE}.reported" 2>/dev/null || true
    # a red or not-tested answer: the workflow uploads this job's full logs (ci-runner.sh logs)
    case "$st" in failure | error) [ -z "${CI_SHA_FILE:-}" ] || printf '%s\t%s\n' "$ctx" "$st" >> "${CI_SHA_FILE}.red" 2>/dev/null || true ;; esac
    return 0
  fi
  case "$err" in
    *"gh auth login"* | *"not logged"* | *"Bad credentials"* | *"HTTP 401"*) why="gh is not signed in" ;;
    *) why="gh exit $rc${err:+: $(printf '%s' "$err" | head -1 | cut -c1-120)}" ;;
  esac
  echo "ci-local: status not posted: $ctx ($why)" >&2
  CI_POST_WHY="$why"
  return "$rc"
}
ci_post_transport_failure() { # ci_post_transport_failure <gh stderr>: 0 when the failure is the network's or GitHub's, not the request's
  case "$1" in
    *"HTTP 4"* | *"gh auth login"* | *"not logged"*) return 1 ;; # a 4xx (422, 401, 403): the request is wrong, a second try says the same
    *"unexpected end of JSON input"* | *"HTTP 5"* | *[Tt]imeout* | *"timed out"* | *[Cc]onnection\ reset* | *"EOF"*) return 0 ;;
  esac
  [ -z "$1" ] # an empty reply: nothing came back to say what was wrong
}
ci_still_ours() { # ci_still_ours <slug> <sha> <job> <url>: 0 if the newest local-ci/<job> status of that commit is still the pending
  # one this run posted (same link). Anything else means someone answered since (the other machine, a newer run): not ours to
  # overwrite with an error. If GitHub can't say, 0: closing a status that might be ours is the safer mistake than leaving it pending.
  local rows ctx state turl
  rows="$(gh api "repos/$1/commits/$2/status?per_page=100" --jq '.statuses[] | [.context, .state, (.target_url // "")] | @tsv' 2>/dev/null)" || return 0
  [ -n "$rows" ] || return 0
  while IFS=$'\t' read -r ctx state turl; do
    [ "$ctx" = "$(ci_context "$3")" ] || continue
    [ "$state" = pending ] && [ "$turl" = "$4" ]
    return
  done <<ROWS
$rows
ROWS
  return 0
}
ci_settle_run() { # ci_settle_run <record dir>: a run that ends owes GitHub an answer for every pending status it posted, so a
  # cancel, a crash or a kill never leaves one pending for good. Jobs it already reported (marker in reported/) are left alone.
  # Two lists, the same format: `posted` (bare job names, as every ci-local.sh reads them) and `posted-contexts` (the contexts
  # under another prefix, ci-part/ and report-ci/, which an older ci-local.sh must never see; see where they are written).
  ci_settle_list "$1" posted
  ci_settle_list "$1" posted-contexts
}
ci_settle_list() { # ci_settle_list <record dir> <list>: one list of the record. It is moved aside first: the run's own cleanup
  # and its watchdog may both come here, and only one posts.
  local rec="$1" mine slug where url attempt="" sha job pids="" _m
  [ -f "$rec/$2" ] || return 0
  mine="$rec/$2.$$"
  mv "$rec/$2" "$mine" 2>/dev/null || return 0
  IFS=$'\t' read -r slug where url < "$mine"
  [ ! -f "$rec/attempt" ] || attempt="$(head -1 "$rec/attempt")" # CI_ATTEMPT_URL; none in a one-machine run or an older record
  while IFS=$'\t' read -r sha job; do
    [ -n "$sha" ] && [ -n "$job" ] || continue
    _m="${job##*/}"
    case "$job" in nightly-ci/* | hostile-ci/*) _m="${_m#part-}" _m="${_m#report-}" ;; esac # the marker is the job's name (nightly-ci/part-check: check)
    [ ! -e "$rec/reported/$_m" ] || continue # a context (prefix/job), or a bare job
    # a bare job is the context it always meant, whatever prefix this run (a reaper of another's record) posts under
    case "$job" in */*) ;; *) job="$(CI_STATUS_PREFIX='' CI_NIGHTLY='' CI_HOSTILE='' ci_context "$job")" ;; esac
    {
      local red
      ci_still_ours "$slug" "$sha" "$job" "$url" || exit 0
      # another machine of this attempt already said red: that red stands, not an error from this cancel
      red="$(ci_attempt_rows "$slug" "$sha" "$job" "$attempt" | ci_attempt_red)" || red=""
      if [ -n "$red" ]; then ci_post_status "$slug" "$sha" "$job" failure "$red" "$url"
      elif [ -e "$rec/cancelled" ]; then ci_post_status "$slug" "$sha" "$job" error "not tested: run cancelled before this job reported (on $where); re-run" "$url"
      else ci_post_status "$slug" "$sha" "$job" error "run on $where ended before this job reported (cancelled or interrupted); re-run" "$url"; fi
    } &
    pids="$pids $!"
  done < <(tail -n +2 "$mine")
  [ -z "$pids" ] || wait $pids
  rm -f "$mine"
}
ci_end_run() { # ci_end_run <record dir> [locks dir] [own]: stop everything a run left, then the record goes, so finding no record means
  # nothing left. With a locks dir, the run's locks go too, just before the record: only for a run that is gone or is ending (a
  # waiter taking one lock from a dead run must not release the lock it is taking over, so it passes none).
  local rec="$1" wt
  [ -d "$rec" ] || return 0
  ci_settle_run "$rec" # first, in parallel and quick: a runner gives a cancelled job only seconds
  ci_stop_groups "$rec/groups" "${3:-}" # own: the run itself ending (its cleanup, its watchdog); else a reap of a run that is gone
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
  [ ! -s "$rec/tmp" ] || case "$(cat "$rec/tmp")" in */talos-ci-s[0-9]* | */talos-hv-s[0-9]*) chmod -R u+w "$(cat "$rec/tmp")" 2>/dev/null; rm -rf "$(cat "$rec/tmp")" ;; esac
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
  [ -z "${CI_TURN_HELD:-}" ] || ci_turn_leave # stopped between the turn lock's take and its release
  ci_drop_marker # a takeover killed part way: its claim must not outlive us
  [ -z "${CI_TICKET:-}" ] || rm -f "$CI_TICKET" "$CI_TICKET.part" # stopped while waiting: its place in the queue goes too
  CI_TICKET=""
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

ci_acquire_slot() { # ci_acquire_slot <locks dir> <what>: wait for a calm machine, a free slot and (ci_turn_*) a turn that no gate holds; sets CI_SLOT
  local dir="${1:?}" what="$2" deadline state said="" n busy turns="" tk="" besides="" push_t0="" push_ahead="" push_max="${CI_TURN_MAX_S:-3000}"
  case "$push_max" in '' | *[!0-9]*) push_max=3000 ;; esac
  deadline=$(($(date +%s) + CI_LOCK_TIMEOUT))
  mkdir -p "$dir"
  # a run waits in locks.queue/admit, so a gate that came after it lets it go first (ci_turn_ahead); a run inside a holder never waits
  if [ "${TALOS_CI_NESTED:-0}" != 1 ] && ! ci_suites_nested "$dir" && ci_turn_on "$dir" && mkdir -p "$dir.queue/admit" 2>/dev/null; then
    turns=1
    ci_self
    tk="$dir.queue/admit/$(perl -MTime::HiRes=time -e 'printf "%017.6f", time').$CI_SELF_PID.$RANDOM"
    CI_TICKET="$tk"
    printf '%s\n' "$CI_SELF_PID" "$(ci_proc_start "$CI_SELF_PID")" "$CI_NONCE" "$what" "" ci "$(ci_scheduled_run && echo sched || echo "caps $(ci_turn_num "${CI_TURN_PASS_MAX:-}" 2) $(ci_turn_num "${CI_TURN_PASS_MAX_S:-}" 1800)")" > "$tk.part" && mv -f "$tk.part" "$tk" || { rm -f "$tk.part"; turns="" tk="" CI_TICKET=""; }
  fi
  while :; do
    rm -rf "$dir"/*.gone.* 2>/dev/null # renamed away by a release that was killed before it deleted them
    if ci_legacy_busy "$(dirname "$dir")"; then
      state="legacy"
      [ "$state" = "$said" ] || echo "ci-local: waiting for a run of the old single-lock script ($(cat "$(dirname "$dir")/lock/what" 2>/dev/null))"
    elif ci_load_high; then
      state="load"
      [ "$state" = "$said" ] || echo "ci-local: waiting: 5-min load average $(ci_load5) is above CI_MAX_LOAD=$CI_MAX_LOAD"
    else
      n=1 busy="" state=""
      # the switch is read on every look: turned off while this run waits, it stops waiting for a turn
      if [ -n "$turns" ] && ! ci_turn_on "$dir"; then turns="" CI_TICKET=""; [ -z "$tk" ] || rm -f "$tk"; tk=""; fi
      if [ -n "$turns" ]; then # the turn: no gate holds the machine and none is queued before this run (turn.sh); the lock stays held through the take
        if ci_turn_ci_enter "$dir" "$tk" "$what"; then :
        elif ci_turn_overdue; then state="beside" # said when its slot is taken, not before: the gate may be gone by then
        else state="turn: $CI_TURN_SAYS"; fi
      fi
      # a scheduled run starts only on an empty queue (the turn above: no gate; ci_sched_yield: no push run); fail open after CI_TURN_MAX_S, said
      if [ -z "$state" ] && [ -n "$turns" ] && ci_scheduled_run && ci_sched_yield "$dir" "$tk"; then
        if [ -z "$push_t0" ]; then push_t0="$(date +%s)"; ci_turn_done "$dir" "$what" got; fi # the wait for its turn ends here: its row is its own
        if [ $(($(date +%s) - push_t0)) -lt "$push_max" ]; then ci_turn_leave; state="push"; else push_ahead=1; fi
      fi
      case "$state" in
        turn:*) [ "$state" = "$said" ] || echo "ci-local: waiting for its turn: $CI_TURN_SAYS" ;;
        push) [ "$state" = "$said" ] || echo "ci-local: waiting: $CI_SCHED_SAYS, and a scheduled run starts when the queue is empty" ;;
        *)
          while [ "$n" -le "$CI_SLOTS" ]; do
            if ci_lock_try "$dir/slot-$n" "$what"; then
              if ci_scheduled_run; then : > "$dir/slot-$n/sched"; else rm -f "$dir/slot-$n/sched"; fi # ci_sched_yield: a scheduled run's slot is no push run's
              ci_turn_leave
              [ -z "$push_ahead" ] || echo "ci-local: went ahead of a busy queue after $((($(date +%s) - push_t0) / 60)) min (CI_TURN_MAX_S): $CI_SCHED_SAYS" >&2
              [ -z "$tk" ] || { rm -f "$tk"; CI_TICKET=""; }
              if [ "$state" = beside ]; then
                case "$CI_TURN_BASE" in "the turn lock is busy"*) besides="went ahead because the turn lock stayed busy" ;; *) besides="ran beside a gate" ;; esac
                echo "ci-local: $besides after $(($(ci_turn_waited) / 60)) min (CI_TURN_MAX_S): $CI_TURN_SAYS" >&2
                ci_turn_alert "$dir" "CI run $what $besides after $(($(ci_turn_waited) / 60)) min of waiting for its turn (CI_TURN_MAX_S): $CI_TURN_SAYS" beside
                ci_turn_done "$dir" "$what" "ran beside"
              else ci_turn_done "$dir" "$what" got; fi
              CI_SLOT=$n # last: a wait cut off before here leaves it empty, and the caller ends the run (wait_cut_unless)
              return 0
            fi
            busy="$busy${busy:+, }slot-$n: $(cat "$dir/slot-$n/what" 2>/dev/null)"
            n=$((n + 1))
          done
          ci_turn_leave
          state="slots"
          [ "$state" = "$said" ] || echo "ci-local: waiting for a free slot ($busy)"
          ;;
      esac
    fi
    said="$state"
    case "$state" in
      turn:* | push) deadline=$(($(date +%s) + CI_LOCK_TIMEOUT)) ;; # its own cap (CI_TURN_MAX_S), after which the run goes ahead: never "not tested"
      *) [ "$(date +%s)" -lt "$deadline" ] || { [ -z "$tk" ] || { rm -f "$tk"; CI_TICKET=""; }; echo "ci-local: lock timeout (${CI_LOCK_TIMEOUT}s waiting for a slot)" >&2; return 1; } ;;
    esac
    sleep "$CI_POLL"
  done
}

# ---- machine-wide mutexes, and the heavy lock ------------------------------------------------------------------------------
# The suites mutex (locks/mutex-suites) is the machine's ONE heavy-work lock: CI's suites and builds take it here, and the rest
# of the heavy work (the gate's suites, the desktop Swift suites, stress loops, evals) through scripts/heavy-lock.sh, which calls
# this same function. Every mutex is first come, first served: a waiter puts a ticket in <locks>.queue/<name>/ (its pid, start
# time, nonce and what it runs; named by the time it came, so the oldest sorts first) and tries only when every older ticket is
# gone or belongs to a waiter that died. A caller inside a holder passes straight through: TALOS_HELD_LOCKS names each lock with
# its holder's owner text (pid, start time, nonce), and counts only while that is still the lock's owner and alive, so a leaked
# or copied value never skips the queue. Before the heavy lock is taken, the guard may hold the job back (ci_guard).
ci_self() { # CI_SELF_PID: this shell's own pid, a subshell's too ($$ is the main shell's, and bash 3.2 has no BASHPID)
  local f
  if [ -n "${BASHPID:-}" ]; then CI_SELF_PID="$BASHPID"; return 0; fi
  f="$(mktemp "${TMPDIR:-/tmp}/ci-self.XXXXXX")" || { CI_SELF_PID=$$; return 0; }
  sh -c 'echo "$PPID"' > "$f" # forked by this very shell, so its parent is this shell
  read -r CI_SELF_PID < "$f"
  rm -f "$f"
}
ci_held_key() { ci_owner "$1" | tr '\n' '|'; } # ci_held_key <lock>: the owner text on one line, as TALOS_HELD_LOCKS holds it
ci_mutex_nested() { # ci_mutex_nested <lock>: 0 if the caller runs inside the lock's current, living holder
  local key
  [ -n "${TALOS_HELD_LOCKS:-}" ] || return 1
  key="$(ci_held_key "$1")"
  [ -n "$key" ] || return 1
  case "$TALOS_HELD_LOCKS" in *"<$1=$key>"*) ;; *) return 1 ;; esac
  ci_owner_alive "$(ci_owner "$1")"
}
# The suites mutex is N wide: N is how many heavy holds (CI's suites, gates, evals) run at once. Slot 1 IS locks/mutex-suites, what
# every older copy of these scripts takes. With N of 2 or more the first K slots (1..K) are CI's: ci-local's jobs take them, so the
# jobs of one run (check's suites, the Swift jobs) overlap, up to K at once, and CI never waits behind a builder's gate (a gate runs
# 30-60 min, and CI is only ever served first among those who wait); a gate, a loop or an eval (heavy-lock.sh) takes slots K+1..N
# (locks/mutex-suites-<K+1> ... -N) and never a CI slot. K is TALOS_CI_SLOTS, else the first line of <cache>/ci-slots, else 2 (at
# most N-1). With N of 1 there is one slot and everyone shares it, CI first: the lock as it always was. During a rollout an older
# gate (its copy of these scripts) still takes slot 1 and CI waits for it, as before; that ends as worktrees rebase. N is
# TALOS_HEAVY_SLOTS, else the first line of <cache>/heavy-slots (a machine-local file, so the number changes with no code change),
# else 4 (two CI's, two builders'); at most 8.
ci_heavy_slots() { # ci_heavy_slots <cache dir>
  local n="${TALOS_HEAVY_SLOTS:-}"
  case "$n" in '' | *[!0-9]* | 0) n="$(head -1 "$1/heavy-slots" 2>/dev/null | tr -d ' \t\r')" ;; esac
  case "$n" in '' | *[!0-9]* | 0) n=4 ;; esac
  n=$((10#$n))
  [ "$n" -le 8 ] || n=8
  echo "$n"
}
ci_ci_slots() { # ci_ci_slots <cache dir> <slots>: K, how many of the slots are CI's (1 when there is just one slot, which all share)
  local n="${TALOS_CI_SLOTS:-}" s="$2"
  [ "$s" -ge 2 ] || { echo 1; return; }
  case "$n" in '' | *[!0-9]* | 0) n="$(head -1 "$1/ci-slots" 2>/dev/null | tr -d ' \t\r')" ;; esac
  case "$n" in '' | *[!0-9]* | 0) n=2 ;; esac
  n=$((10#$n))
  [ "$n" -le $((s - 1)) ] || n=$((s - 1))
  echo "$n"
}
ci_in_list() { local x="$1" y; shift; for y in "$@"; do [ "$y" = "$x" ] && return 0; done; return 1; } # ci_in_list <item> <list...>
ci_suites_lock() { if [ "$2" = 1 ]; then echo "$1/mutex-suites"; else echo "$1/mutex-suites-$2"; fi; } # ci_suites_lock <locks dir> <slot>
ci_suites_nested() { # ci_suites_nested <locks dir>: 0 if the caller runs inside the holder of any slot of the suites mutex
  local l
  for l in "$1/mutex-suites" "$1"/mutex-suites-[0-9]*; do
    [ -d "$l" ] && ci_mutex_nested "$l" && return 0
  done
  return 1
}
# CI's quiet group (the contract and schedules suites, which give a real bridge and the real Chronos CLI 3 s to answer) marks itself
# while it runs, in <locks>/quiet-group: its owner text, which counts only while that is still slot 1's living owner. While it is
# marked no NEW gate hold starts (a gate waiting for slots 2..N holds back, keeping its place); gates that run already finish.
ci_quiet_active() { # ci_quiet_active <locks dir>
  local m="$1/quiet-group" o
  [ -f "$m" ] || return 1
  o="$(ci_owner "$1/mutex-suites")"
  [ -n "$o" ] && [ "$(cat "$m" 2>/dev/null)" = "$o" ] && ci_owner_alive "$o"
}
ci_gate_slots_busy() { # ci_gate_slots_busy <locks dir>: how many of the gates' slots (above CI's) have a living holder
  local l n=0 k o c
  c="$(ci_ci_slots "$(dirname "$1")" "$(ci_heavy_slots "$(dirname "$1")")")"
  for l in "$1"/mutex-suites-[0-9]*; do
    k="${l##*/mutex-suites-}"
    case "$k" in '' | *[!0-9]*) continue ;; esac
    [ "$k" -gt "$c" ] || continue
    o="$(ci_owner "$l")"
    { [ -n "$o" ] && ci_owner_alive "$o"; } && n=$((n + 1))
  done
  echo "$n"
}
CI_QUIET_T0="" CI_QUIET_BUSY0="" CI_QUIET_FLAKE0=0
ci_flake_lines() { if [ -n "${CI_FLAKE_FILE:-}" ] && [ -f "$CI_FLAKE_FILE" ]; then wc -l < "$CI_FLAKE_FILE" | tr -d ' '; else echo 0; fi; }
ci_quiet_begin() { # ci_quiet_begin <locks dir>: the quiet group starts (in the suites hold this run has)
  ci_me > "$1/quiet-group" 2>/dev/null
  CI_QUIET_T0="$(date +%s)" CI_QUIET_BUSY0="$(ci_gate_slots_busy "$1")" CI_QUIET_FLAKE0="$(ci_flake_lines)"
}
ci_quiet_end() { # ci_quiet_end <locks dir> <exit code>: it ends: the marker goes, and one row in <cache>/logs/quiet-group.tsv: UTC time,
  # the commit, pass or fail, seconds, the files that failed and passed on retry meanwhile (CI_FLAKE_FILE), and the gate slots busy at
  # the start and at the end, to read what the gates cost it
  local rc="$2" res=pass
  [ "$(cat "$1/quiet-group" 2>/dev/null)" != "$(ci_me)" ] || rm -f "$1/quiet-group"
  [ "$rc" = 0 ] || res=fail
  mkdir -p "$1/../logs" 2>/dev/null &&
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "${SHORT:-?}" "$res" "$(($(date +%s) - ${CI_QUIET_T0:-$(date +%s)}))" \
      "$(($(ci_flake_lines) - CI_QUIET_FLAKE0))" "${CI_QUIET_BUSY0:-?}" "$(ci_gate_slots_busy "$1")" >> "$1/../logs/quiet-group.tsv" 2>/dev/null
  return 0
}
ci_slots_busy() { # ci_slots_busy <lock dir...>: how many of these slots have a living holder
  local l o n=0
  for l in "$@"; do
    o="$(ci_owner "$l")"
    { [ -n "$o" ] && ci_owner_alive "$o"; } && n=$((n + 1))
  done
  echo "$n"
}
ci_active() { # ci_active <locks dir> <K> <queue dir>: 0 while a CI job holds one of CI's slots 1..K, or waits for one
  local k o t
  for ((k = 1; k <= $2; k++)); do
    o="$(ci_owner "$(ci_suites_lock "$1" "$k")")"
    { [ -n "$o" ] && ci_owner_alive "$o"; } && return 0
  done
  while IFS= read -r t; do
    [ -n "$t" ] && [ "$(ci_ticket_kind "$t")" = ci ] && return 0
  done <<ORDER
$(ci_queue_order "$3" "$3/none")
ORDER
  return 1
}
# What a CI hold of one of several CI slots gets of its own, as a gate's slot does (heavy-lock.sh, hl_slot_env): the slot's preview port
# (4973 + 10 * (slot - 1), TALOS_CI_HOLD_PW_PORT moves it: a range of its own, never the builders' 4173 nor the run slots' 4873 and up)
# and tmux socket prefix, and TALOS_HEAVY_SLOT; set for the hold and put back after (the shell goes on to other holds). Its temp folder
# is its job's own (ci-local.sh, job_tmp).
CI_ENV_SAVE=()
ci_hold_env_push() { # ci_hold_env_push <slot>
  CI_ENV_SAVE=("${PW_PORT-__unset__}" "${TALOS_HEAVY_SLOT-__unset__}" "${TALOS_TEST_TMUX_PREFIX-__unset__}")
  export TALOS_HEAVY_SLOT="$1" PW_PORT=$((${TALOS_CI_HOLD_PW_PORT:-4973} + ($1 - 1) * 10)) TALOS_TEST_TMUX_PREFIX="talos-test-s$1"
}
ci_hold_env_pop() {
  local i=0 v name
  for name in PW_PORT TALOS_HEAVY_SLOT TALOS_TEST_TMUX_PREFIX; do
    v="${CI_ENV_SAVE[i]}"
    if [ "$v" = __unset__ ]; then unset "$name"; else export "$name=$v"; fi
    i=$((i + 1))
  done
}
ci_since() { perl -MPOSIX=strftime -e 'my @s = stat shift; print @s ? strftime("%H:%M:%S", localtime $s[9]) : "?"' "$1"; }
# The order waiters go in: CI first, always (main's verdict comes before anyone's push), then everything else (push gates, builder
# gates, heavy-lock.sh runs), first come first served within each. A holder is never stopped for anyone: this is only who goes
# next. The one ticket that goes before CI says "jump" (line 5; HEAVY_LOCK_JUMP=1 when it asked): gate-push.sh's checked
# --red-main gate (the CI it passes judges the commits it turns green). No other gate jumps, however often it was refused.
# This order is who goes next within one queue; between a gate's hold and a whole CI run the turn decides (turn.sh, ci_turn_ahead).
# HEAVY_LOCK_TIMEOUT (exit 75: the gate refuses, saying it could not get the heavy lock) caps a wait behind a stream of reruns or
# other machines' pushes. The ticket carries what it is, so every waiter reads the same order, whatever its own settings.
ci_ticket_kind() { # ci_ticket_kind <ticket>: jump, ci, push or run. CI by line 6 "ci", which ci_mutex writes only for a ci-local
  # slot (heavy-lock.sh always says push or run), so a run named "slot 1" is no CI; an old ticket with no line 6 is CI by its "slot N"
  local x what="" jump="" kind=""
  { IFS= read -r x && IFS= read -r x && IFS= read -r x && IFS= read -r what && IFS= read -r jump && IFS= read -r kind; } < "$1" 2>/dev/null
  if [ "$jump" = jump ]; then echo jump
  elif [ -n "$kind" ]; then echo "$kind"
  else case "$what" in "slot "*) echo ci ;; *) echo run ;; esac; fi
}
ci_queue_order() { # ci_queue_order <queue dir> <this ticket>: the living tickets, one per line, in the order they go
  local t who jump="" ci="" sched="" rest=""
  for t in "$1"/*; do
    case "$t" in *.part) continue ;; esac # a ticket still being written: not in the queue yet
    [ -f "$t" ] || continue
    if [ "$t" != "$2" ]; then
      who="$(sed -n 1,3p "$t" 2>/dev/null)"
      if [ -z "$who" ] || ! ci_owner_alive "$who"; then rm -f "$t"; continue; fi # a waiter that died: its place goes
    fi
    case "$(ci_ticket_kind "$t")" in
      jump) jump="$jump$t"$'\n' ;;
      ci) if ci_ticket_sched "$t"; then sched="$sched$t"$'\n'; else ci="$ci$t"$'\n'; fi ;;
      *) rest="$rest$t"$'\n' ;;
    esac
  done
  printf '%s' "$jump$ci$sched$rest"
}
ci_class_order() { # ci_class_order <queue dir> <this ticket>: ci_queue_order, of the tickets that want the same slots as the caller:
  # CI_QCLASS=ci (a ci-local ticket, which takes slot 1 only) the CI tickets, gate (everything else, which takes slots 2..N) the
  # others; unset, all of them (one slot: everyone shares it)
  local t
  ci_queue_order "$1" "$2" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    case "${CI_QCLASS:-}" in
      ci) [ "$(ci_ticket_kind "$t")" = ci ] || continue ;;
      gate) [ "$(ci_ticket_kind "$t")" != ci ] || continue ;;
    esac
    printf '%s\n' "$t"
  done
}
ci_first_in_line() { # ci_first_in_line <queue dir> <ticket>: 0 when this ticket goes next (ci_class_order)
  [ -f "$2" ] || return 0
  [ "$(ci_class_order "$1" "$2" | sed -n 1p)" = "$2" ] # not head -1: it closes the pipe early, and a shell that ignores SIGPIPE (the runner's) prints "write error: Broken pipe" for each ticket after the first
}
ci_wait_line() { # ci_wait_line <label> <queue dir> <ticket> <lock...>: "waiting for <label>, held by pid N (<what>, since
  # HH:MM:SS); K ahead"; with several slots, every holder: "held by pid N (...) and pid M (...)"
  local label="$1" q="$2" tk="$3" owner pid ahead=0 t l held=""
  shift 3
  while IFS= read -r t; do
    [ "$t" = "$tk" ] && break
    ahead=$((ahead + 1))
  done <<ORDER
$(ci_class_order "$q" "$tk")
ORDER
  for l in "$@"; do
    owner="$(ci_owner "$l")"
    pid="$(printf '%s\n' "$owner" | sed -n 1p)"
    [ -n "$pid" ] || continue
    held="$held${held:+ and }pid $pid ($(head -1 "$l/what" 2>/dev/null), since $(ci_since "$l/owner"))"
    [ "$owner" != "$(ci_me)" ] || held="$held (this run)" # a slot this run's own waiter holds so far (an exclusive hold), or a job of this run
  done
  printf 'waiting for %s' "$label"
  [ -z "$held" ] || printf ', held by %s' "$held"
  [ "$ahead" = 0 ] || printf '; %s ahead' "$ahead"
}
# The guard: one hook, called before a heavy job starts (Delphi's load and memory guard goes here). An executable at
# TALOS_HEAVY_GUARD (default scripts/heavy-guard.sh), given the job's name. Exit 0: go. Exit 75: not now; the job keeps its
# place in the queue, does not hold the lock, and asks again. Anything else, or no guard at all: go (a broken guard never blocks).
ci_guard() { # ci_guard <job> [<lock>]: 0 = go; 1 = not now, with the guard's first line in CI_GUARD_SAYS
  # Given the lock, the guard is told the cache that lock lives in (<cache>/locks/mutex-<name>): ci-local.sh unsets
  # TALOS_CI_CACHE for its run, and the guard would otherwise read another cache's settings and see no holder.
  local g="${TALOS_HEAVY_GUARD:-${CI_LOCAL_LIB:-.}/../heavy-guard.sh}" out rc
  [ -x "$g" ] || return 0
  if [ -n "${2:-}" ]; then out="$(TALOS_CI_CACHE="$(dirname "$(dirname "$2")")" "$g" "$1" 2>&1)"; else out="$("$g" "$1" 2>&1)"; fi
  rc=$?
  [ "$rc" = 0 ] && return 0
  if [ "$rc" = 75 ]; then CI_GUARD_SAYS="$(printf '%s\n' "$out" | head -1)"; return 1; fi
  echo "${CI_MSG:-ci-local}: the guard failed (exit $rc); running anyway" >&2
  return 0
}
ci_wait_log() { # <locks dir> <lock> <what> <asked at> <got|timed out> <kind>: a wait of 1 s or more, for the record of who waits
  # for whom. logs/lock-waits.tsv: UTC time, lock, what (tabs and newlines made spaces), seconds, got or timed out, kind (ci, push
  # or run: ci_queue_order). Append only.
  local waited=$(($(date +%s) - $4)) what
  [ "$waited" -ge 1 ] && mkdir -p "$1/../logs" 2>/dev/null || return 0
  what="$(printf '%s' "$3" | tr '\t\n' '  ')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$2" "$what" "$waited" "$5" "$6" >> "$1/../logs/lock-waits.tsv" 2>/dev/null
}
# The heavy lock shared across WSL distros (Titan: Ubuntu, where builders' gates and requested suites run, and talos-ci, where the
# runner's jobs run, are one VM with one CPU, but each has its own ~/.cache/talos-ci and its own PID namespace, so the mutex
# above cannot see the other side's holder, and a pid from the other side would read as dead). CI_SHARED_LOCK=<file> on a
# path both distros mount (/mnt/wsl is one tmpfs for all of them) adds a kernel flock on that file around the suites mutex's
# command: the kernel frees it when the holder dies, whichever distro it was in. Opt in only (the runner's .env, the gate's
# environment); unset everywhere else, so a Mac or another Linux box changes nothing. TALOS_SHARED_LOCK_HELD marks a holder's
# descendants (a gate's tests, a run inside a CI job), which pass straight through instead of waiting on their own holder.
ci_shared_wanted() {
  [ -n "${CI_SHARED_LOCK:-}" ] && [ "${TALOS_SHARED_LOCK_HELD:-}" != "$CI_SHARED_LOCK" ] && command -v flock > /dev/null 2>&1
}
# The flock is held on fd 197 of the shell that runs ci_mutex, never in a subshell (the command's functions set globals the caller
# reads, heavy-lock.sh's HL_STARTED). The command runs with fd 197 closed (ci_mutex: "$@" 197>&-), so every program it starts,
# a server a test leaves behind included, runs without the lock. One limit: bash keeps a saved copy of the fd while the function
# runs, and a subshell forked then (`( … ) &`, `together`'s steps) keeps that copy until it exits; one that outlives the
# command would hold the lock until it ends. The wait polls (flock -n) rather than blocking, so a TERM to the waiter is acted
# on within CI_POLL, as in the mutex's own wait.
CI_SHARED_OUTER=""
# Who holds it is written beside it (<file>.holder: the holder's `what`, as the mutex's status shows it), so a waiter says whom it
# waited behind. A wait ends with one line, "waited <n>s for <label> shared across WSL distros, behind: <what>", which the
# shadow comparison reads (a browser-e2e part that waited behind a requested suite is not a CI wait).
ci_shared_name() { # the holder's name as written beside the lock: one line, printable, at most 120 characters; empty when none
  head -1 "$CI_SHARED_LOCK.holder" 2>/dev/null | LC_ALL=C tr -cd '[:print:]' | cut -c1-120
}
# CI goes first: a waiting CI run (ci_mutex's kind ci: a ci-local slot) is served before any waiting request (heavy-lock.sh: a gate,
# a suite another machine asked for, a loop), whichever distro each is in; nothing running is stopped. A CI waiter says so in a
# file beside the lock (<file>.ci.<id>), touched on each look; a request does not take the lock while one of those is fresh (touched
# within CI_SHARED_CI_FRESH seconds, 30: a CI waiter that was killed stops counting then). A CI waiter's own wait is the kernel's
# (a blocking flock in the background), so it gets the lock the moment the holder lets go; a request polls (flock -n).
ci_shared_ci_waiting() { # 0 when a CI run waits for the shared lock (a fresh marker beside it)
  local now m t
  now=$(date +%s)
  for m in "$CI_SHARED_LOCK".ci.*; do
    [ -e "$m" ] || continue
    t=$(stat -c %Y "$m" 2>/dev/null) || continue
    [ $((now - t)) -lt "${CI_SHARED_CI_FRESH:-30}" ] && return 0
    [ $((now - t)) -lt 300 ] || rm -f "$m" 2>/dev/null # a killed waiter's, long stale: nothing reads it again
  done
  return 1
}
# A CI run's marker is made when it asks for its own distro's mutex (ci_mutex), not only at the flock: a CI run queued behind
# another CI run there is waiting too, and a request on the other side must not slip in between the two.
CI_SHARED_MARK=""
ci_shared_mark() { # ci_shared_mark: make (or refresh) this CI waiter's marker
  if [ -z "$CI_SHARED_MARK" ]; then CI_SHARED_MARK="$CI_SHARED_LOCK.ci.${WSL_DISTRO_NAME:-x}-$$-$RANDOM"; fi
  : 2>/dev/null >> "$CI_SHARED_MARK" && touch "$CI_SHARED_MARK" 2>/dev/null || true
}
ci_shared_unmark() { [ -z "$CI_SHARED_MARK" ] || rm -f "$CI_SHARED_MARK"; CI_SHARED_MARK=""; }
ci_shared_take() { # ci_shared_take <deadline> <label> [what] [ci]: hold the shared flock (waiting up to the deadline); exit 1 when not had
  # The holder's name is read on every look, so the line names everyone it waited behind.
  local deadline="$1" label="$2" what="${3:-?}" ci="${4:-}" f="$CI_SHARED_LOCK" t0 behind="" n fp left
  exec 197>> "$f" || return 1
  t0=$(date +%s)
  if [ -n "$ci" ]; then
    if ! flock -n 197; then
      behind="$(ci_shared_name)"
      echo "${CI_MSG:-ci-local}: waiting for $label, which the other WSL distro holds ($f; holder: ${behind:-unknown})" >&2
      ci_shared_mark; ci_part_beat "$label, which the other WSL distro holds"
      left=$((deadline - t0))
      [ "$left" -gt 0 ] || left=1
      flock -w "$left" 197 &
      fp=$!
      # looked at each second, not each CI_POLL: the lock is had the moment the holder lets go, and must not sit idle here
      while kill -0 "$fp" 2>/dev/null; do
        ci_shared_mark; ci_part_beat
        n="$(ci_shared_name)"
        case "|${behind}|" in *"|${n:-unknown}|"*) ;; *) behind="${behind:+$behind|}${n:-unknown}" ;; esac
        sleep 1
      done
      if ! wait "$fp"; then
        ci_shared_unmark
        exec 197>&-
        echo "${CI_MSG:-ci-local}: timed out waiting for $label shared across distros ($f)" >&2
        return 1
      fi
    fi
    ci_shared_unmark
  else
    # a request: never past a waiting CI run, never while another holds it
    until ! ci_shared_ci_waiting && flock -n 197; do
      if [ -z "$behind" ]; then
        behind="$(ci_shared_name)"
        ci_shared_ci_waiting && behind="${behind:+$behind|}a waiting CI run"
        echo "${CI_MSG:-ci-local}: waiting for $label, which the other WSL distro holds ($f; holder: ${behind:-unknown})" >&2
      fi
      n="$(ci_shared_name)"
      case "|${behind}|" in *"|${n:-unknown}|"*) ;; *) behind="${behind:+$behind|}${n:-unknown}" ;; esac
      if [ "$(date +%s)" -ge "$deadline" ]; then
        exec 197>&-
        echo "${CI_MSG:-ci-local}: timed out waiting for $label shared across distros ($f)" >&2
        return 1
      fi
      sleep "${CI_POLL:-5}"
    done
  fi
  [ -z "$behind" ] || echo "${CI_MSG:-ci-local}: waited $(($(date +%s) - t0))s for $label shared across WSL distros, behind: ${behind:-unknown}" >&2
  printf '%s\n' "$what" 2>/dev/null > "$f.holder" || true; ci_part_beat_end
  CI_SHARED_OUTER="${TALOS_SHARED_LOCK_HELD-__unset__}"
  export TALOS_SHARED_LOCK_HELD="$f"
}
ci_shared_drop() { # the name cleared (a holder that writes none reads as unknown, never as this one), the fd closed, the marker restored
  : 2>/dev/null > "$CI_SHARED_LOCK.holder" || true
  exec 197>&-
  if [ "$CI_SHARED_OUTER" = __unset__ ]; then unset TALOS_SHARED_LOCK_HELD; else export TALOS_SHARED_LOCK_HELD="$CI_SHARED_OUTER"; fi
}
ci_mutex() { # ci_mutex <locks dir> <name> <cmd...>: run cmd holding a machine-wide mutex, for a resource a slot can't own
  # CI_MUTEX_WHAT says what the holder runs (status and the waiting line show it); CI_MUTEX_JOB is the name the guard is given.
  local lock="$1/mutex-$2" name="$2" q="$1.queue/$2" deadline said="" line t rc what label held asked locks="$1" free_since="" grace="${CI_DEFER_GRACE:-15}" owner go
  local slotlocks=("$lock") nslots=1 nci=1 k got l free m mine=() all excl="" busy CI_QCLASS="" env_saved="" jump="" kind=ci sched="" l7="" shared_ci=""
  shift 2
  label="the $name mutex"; [ "$name" != suites ] || label="the heavy lock"
  what="${CI_MUTEX_WHAT:-slot ${CI_SLOT:-?}}"
  # a gate's one jump ahead of queued CI (ci_queue_order): never for a CI slot, never for another mutex; the wait log shows it
  what="${what//$'\n'/ }" what="${what//$'\r'/ }" # one ticket line: a script's own "jump" or "ci" line never reads as the ticket's
  if [ "$name" = suites ] && [ -n "${HEAVY_LOCK_JUMP:-}" ] && [ -n "${CI_MUTEX_WHAT:-}" ]; then jump=jump what="$what [jump]"; fi
  # the kind (ci_queue_order): ci for a ci-local slot, push for gate-push.sh's gate, run for anything else on the heavy lock
  if [ -n "${CI_MUTEX_WHAT:-}" ]; then
    kind=run
    [ "$name" = suites ] && [ -n "${HEAVY_LOCK_PUSH:-}" ] && kind=push
  fi
  if [ "$kind" = ci ] && ci_scheduled_run; then sched=sched; fi # a scheduled run's job (ci_ticket_sched)
  l7="$sched"; [ -n "$l7" ] || [ "$kind" = ci ] || l7=turn2 # line 7 of the ticket: sched, or a gate's turn2 (turn.sh)
  if [ "$name" = suites ]; then ci_suites_nested "$locks" && { "$@"; return; }; elif ci_mutex_nested "$lock"; then "$@"; return; fi
  mkdir -p "$(dirname "$lock")" "$q" || return 1
  ci_self
  t="$q/$(perl -MTime::HiRes=time -e 'printf "%017.6f", time').$CI_SELF_PID.$RANDOM"
  CI_TICKET="$t" # first: ci_release_all takes it (and its .part) away if this shell is stopped at any point while it waits
  printf '%s\n' "$CI_SELF_PID" "$(ci_proc_start "$CI_SELF_PID")" "$CI_NONCE" "$what" "$jump" "$kind" ${l7:+"$l7"} > "$t.part" && mv -f "$t.part" "$t" || return 1
  asked=$(date +%s)
  deadline=$(($(date +%s) + CI_LOCK_TIMEOUT))
  [ "$CI_LOCK_TIMEOUT" != 0 ] || deadline=$(($(date +%s) + 315360000)) # 0 = wait as long as it takes (heavy-lock.sh: a push gate)
  case "$grace" in '' | *[!0-9]*) grace=15 ;; esac
  [ "$name" = suites ] && [ "$kind" = ci ] && ci_shared_wanted && shared_ci=1
  # CI_MUTEX_EXCLUSIVE=1 (ci_mutex_all: ci-local's quiet group, which fails beside anything else): every one of CI's slots, so no
  # other CI job runs beside it, and (ci_quiet_active) no new gate starts
  [ "$name" = suites ] && [ "$kind" = ci ] && excl="${CI_MUTEX_EXCLUSIVE:-}"
  while :; do
    if [ "$name" = suites ]; then # the number of slots is read on every look: a change of the machine's heavy-slots file counts at once
      # With 2 slots or more: a ci-local job (kind ci) has CI's slots 1..K and nothing else, anyone else slots K+1..N, and a waiter
      # goes in turn among those who want the same slots (CI_QCLASS), and whether a gate and CI run together is turn.sh's rule: one class at a time.
      # One slot: shared.
      nslots="$(ci_heavy_slots "$(dirname "$locks")")"
      nci="$(ci_ci_slots "$(dirname "$locks")" "$nslots")"
      slotlocks=() CI_QCLASS=""
      if [ "$nslots" -lt 2 ]; then slotlocks=("$lock")
      elif [ "$kind" = ci ]; then
        CI_QCLASS=ci
        for ((k = 1; k <= nci; k++)); do slotlocks+=("$(ci_suites_lock "$locks" "$k")"); done
      else
        CI_QCLASS=gate
        for ((k = nci + 1; k <= nslots; k++)); do slotlocks+=("$(ci_suites_lock "$locks" "$k")"); done
      fi
    fi
    if [ "$kind" = ci ] && ci_yield "$locks" "$name" "$t"; then # a gate waits (turn.sh): a CI job that holds nothing lets go any slot it took and asks again, its place kept
      for m in ${mine[@]+"${mine[@]}"}; do ci_lock_release "$m"; done; mine=(); [ "$CI_LOCK_TIMEOUT" = 0 ] || deadline=$(($(date +%s) + CI_LOCK_TIMEOUT)) # (capped: ci_yield_starved)
      [ "$CI_YIELD_SAYS" = "$said" ] || { echo "${CI_MSG:-ci-local}: waiting for $label: $CI_YIELD_SAYS" >&2; said="$CI_YIELD_SAYS"; }
      ci_part_beat "$label"; sleep "$CI_POLL"; continue
    fi
    [ -z "$shared_ci" ] || ci_shared_mark # a CI run waiting here waits for the shared lock too: requests on the other side hold off
    # Liveness: a waiter that defers (not first in line) still takes a lock left free, with no living holder, for CI_DEFER_GRACE
    # seconds (default 15, three of ci-local's 5 s polls, so a waiter first in line has had its turn). Otherwise a waiter running
    # other lock code (main's plain first come first served, mid-changeover, or a branch's gate) and this one can each wait for
    # the other while the lock sits free.
    go=""
    # An exclusive waiter (the quiet group) takes slots only when it is first in line, never through this path: two runs' quiet
    # groups could each take one of CI's slots here, and wait for the other's until the timeout.
    if ci_first_in_line "$q" "$t"; then go=1
    elif [ -z "$excl" ] && ! { [ -n "$sched" ] && ci_push_queued "$q" "$t"; }; then # a scheduled job never takes a free slot while a push run's is queued
      free=""
      for l in "${slotlocks[@]}"; do # a slot with no living holder (the mutex has several: any one will do)
        owner="$(ci_owner "$l")"
        { [ -n "$owner" ] && ci_owner_alive "$owner"; } || free=1
      done
      if [ -z "$free" ]; then free_since=""
      else
        [ -n "$free_since" ] || free_since=$(date +%s)
        [ $(($(date +%s) - free_since)) -lt "$grace" ] || go=1
      fi
    fi
    # An exclusive waiter no longer first in line (a push run's came ahead) lets its slots go: two holding one each would wait for each other.
    if [ -z "$go" ] && [ -n "$excl" ] && [ ${#mine[@]} -gt 0 ]; then for m in "${mine[@]}"; do ci_lock_release "$m"; done; mine=(); fi
    if [ -n "$go" ]; then
      if [ "$name" = suites ] && ! ci_guard "${CI_MUTEX_JOB:-$what}" "$lock"; then line="the guard says not now ($CI_GUARD_SAYS)"
      elif [ "$CI_QCLASS" = gate ] && ci_quiet_active "$locks"; then
        line="waiting for $label: CI's quiet group (the contract and schedules suites) holds CI's slots, and no new gate starts until it ends"
      elif [ "$CI_QCLASS" = gate ] && busy="$(ci_slots_busy "${slotlocks[@]}")" && [ "$busy" -ge 2 ] && ci_active "$locks" "$nci" "$q"; then
        line="waiting for $label: CI runs, and at most two gates run beside it"
      elif [ "$CI_QCLASS" = gate ] && ci_turn_on "$locks" && ! ci_turn_gate_enter "$locks" "$t" "$jump"; then
        line="waiting for $label: $CI_TURN_SAYS" # a CI run is on, or was queued before this gate (turn.sh); nothing is stopped
      else
        for l in "${slotlocks[@]}"; do # the first free slot, in order; an exclusive hold takes every one it finds free
          ci_in_list "$l" ${mine[@]+"${mine[@]}"} && continue
          ci_lock_try "$l" "$what" || continue
          mine+=("$l")
          [ -n "$excl" ] || break
        done
        [ -z "${CI_TURN_HELD:-}" ] || [ ${#mine[@]} -eq 0 ] || ci_turn_pass "$locks" # a gate that took its slot (turn lock held) is a pass for the CI runs queued
        ci_turn_leave # the turn lock was kept through the take, if this gate asked for it
        all=1
        for l in "${slotlocks[@]}"; do ci_in_list "$l" ${mine[@]+"${mine[@]}"} || all=""; done
        if [ ${#mine[@]} -gt 0 ] && { [ -z "$excl" ] || [ -n "$all" ]; }; then break; fi
        line="$(ci_wait_line "$label" "$q" "$t" "${slotlocks[@]}")"
      fi
    else
      line="$(ci_wait_line "$label" "$q" "$t" "${slotlocks[@]}")"
    fi
    [ "$line" = "$said" ] || { echo "${CI_MSG:-ci-local}: $line" >&2; said="$line"; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      rm -f "$t"
      CI_TICKET=""
      for m in ${mine[@]+"${mine[@]}"}; do ci_lock_release "$m"; done # an exclusive hold's slots taken so far
      [ -z "$shared_ci" ] || ci_shared_unmark
      ci_turn_done "$locks" "$what" "timed out"; ci_part_beat_end
      echo "${CI_MSG:-ci-local}: timed out waiting for $label" >&2
      ci_wait_log "$locks" "$name" "$what" "$asked" "timed out" "$kind"
      return 1
    fi
    ci_part_beat "$label"; sleep "$CI_POLL" # a part says it still waits (turn.sh)
  done
  rm -f "$t" # the queue folder stays: removing it could race a waiter that has just made it and is writing its ticket
  CI_TICKET=""
  ci_turn_done "$locks" "$what" got # a gate that waited for its turn: its own row (kind turn)
  ci_wait_log "$locks" "$name" "$what" "$asked" got "$kind"; { [ "$name" = suites ] && ci_shared_wanted; } || ci_part_beat_end # (the shared wait ends it below)
  lock="${mine[0]}"
  got=1
  case "$lock" in *mutex-suites-[0-9]*) got="${lock##*-}" ;; esac
  CI_LOCK_HELD="$lock" CI_HEAVY_SLOT="$got" # which slot this hold has (heavy-lock.sh gives its command that slot's own ports and folders)
  held="${TALOS_HELD_LOCKS:-}"
  for m in "${mine[@]}"; do export TALOS_HELD_LOCKS="${TALOS_HELD_LOCKS:-}<$m=$(ci_held_key "$m")>"; done
  # CI's jobs overlap (K slots): each hold has its own preview port and tmux names, as a gate's slot does (its temp folder is its
  # job's own, job_tmp)
  if [ "$name" = suites ] && [ "$kind" = ci ] && [ "$nslots" -ge 2 ] && [ "$nci" -ge 2 ]; then ci_hold_env_push "$got"; env_saved=1; fi
  # the hostile nightly (ci-local.sh sources scripts/ci-local/hostile.sh): CPU load beside each hold of the heavy lock, only then
  local load=()
  [ "$name" != suites ] || ! declare -F ci_hostile_with_load >/dev/null || load=(ci_hostile_with_load "$locks")
  if [ "$name" = suites ] && ci_shared_wanted; then
    if ci_shared_take "$deadline" "$label" "$what" "$([ "$kind" != ci ] || echo ci)"; then
      ${load[@]+"${load[@]}"} "$@" 197>&-
      rc=$?
      ci_shared_drop
    else
      rc=1; ci_part_beat_end # not had in time: as the mutex's own timeout (heavy-lock.sh: the command never started, 75)
      ci_wait_log "$locks" "$name" "$what" "$asked" "timed out (shared)" "$kind"
    fi
  else
    ${load[@]+"${load[@]}"} "$@"
    rc=$?
  fi
  if [ -n "$held" ]; then TALOS_HELD_LOCKS="$held"; else unset TALOS_HELD_LOCKS; fi
  [ -z "$env_saved" ] || ci_hold_env_pop "$env_saved"
  for m in "${mine[@]}"; do ci_lock_release "$m"; done
  return $rc
}
ci_mutex_all() { CI_MUTEX_EXCLUSIVE=1 ci_mutex "$@"; } # ci_mutex_all <locks dir> suites <cmd...>: the same, holding all of CI's slots (the quiet group runs alone among CI)
# the turns of gates and CI runs (ci_turn_*): ci_acquire_slot and ci_mutex call them. A copy of this file without turn.sh beside it
# (a test's, a half-copied folder) has no turns, says so each time it is loaded, and works as before.
if [ -r "$(dirname "${BASH_SOURCE[0]}")/turn.sh" ]; then
  # shellcheck source=turn.sh
  . "$(dirname "${BASH_SOURCE[0]}")/turn.sh"
else
  echo "ci-local: no turn.sh beside locks.sh: a gate and a CI run will not take turns" >&2
  ci_turn_on() { return 1; }
  ci_turn_leave() { return 0; }
  ci_turn_done() { return 0; }
  ci_turn_status() { return 0; }; ci_turn_pass() { return 0; }
  ci_fold_wait() { return 0; }
  ci_yield() { return 1; }; ci_fold_end() { rm -f "$1/folding-$2"; return 0; }
  ci_fold_resume() { rm -f "$1/folding-$2"; return 0; }
  ci_scheduled_run() { return 1; }; ci_ticket_sched() { return 1; }; ci_push_queued() { return 1; }; ci_sched_yield() { return 1; }; ci_part_beat() { return 0; }; ci_part_beat_end() { return 0; } # no scheduled-run rule, no lock-wait beat without turn.sh
fi
