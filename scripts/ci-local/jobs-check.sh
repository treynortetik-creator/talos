# scripts/ci-local/jobs-check.sh: the check job: its suites, the quiet and loud groups, check's parts on other machines, the part jobs, report-ci/fast. Part of scripts/ci-local.sh, which sources it before any wait (functions and
# fixed values only, unchanged from when they were in ci-local.sh). Not run on its own.
# KIT_SKIP (plan_skips): nothing the install and kit tests run changed since the last green commit, so they are left out.
# Arguments, if any, go to Vitest last (the macOS-only subset's files: step_macos_subset).
step_vitest() {
  local skip=()
  if [ "${KIT_SKIP:-0}" = 1 ]; then
    skip=(--exclude '**/root-install*.test.ts' --exclude '**/kit-tests.test.ts')
    echo "ci-local: install and kit tests skipped: nothing they run changed since the last green commit"
  fi
  # The full run (--full, and every dispatch of the runner) also runs self-test.sh's suites inside test-default-agent.sh;
  # every other run leaves out that second run of the kit suites (scripts/kit-tests.test.ts).
  # --retry=0: no test runs twice, whatever the commit's own config says (the owner's rule: no retries anywhere; scripts/ci-no-retries.test.ts).
  # The flake reporter (ours, not the commit's) stays: it writes a test that passed only on a retry to CI_FLAKE_FILE, and none can now.
  TALOS_KIT_FULL_SELF_TEST="$FULL" pnpm test --maxWorkers="$CI_WORKERS" ${skip[@]+"${skip[@]}"} \
    --retry=0 --reporter=default --reporter="$ROOT/scripts/ci-flake-vitest.ts" --reporter="$ROOT/scripts/ci-test-results-vitest.ts" "$@"
}
# The installer's core tests once more with a corepack pnpm first on PATH (scripts/corepack-install-tests.sh, as `pnpm
# test:corepack-install`), as a Mac set up by SETUP.md has it: its own step, because a harness fault that only a corepack pnpm
# shows (KIT-8, red at 05676ca3) passed on every CI machine, whose pnpm is not corepack's. Left out with the install tests
# themselves when nothing they run changed (KIT_SKIP), and runs on a Mac only (the pnpm a user's Mac has; Titan's Linux check does not
# double it, nor need a Node with corepack); on a Mac without corepack it fails ("corepack missing"), never skips.
step_corepack_install() {
  if [ "${KIT_SKIP:-0}" = 1 ]; then
    echo "ci-local: the install tests with a corepack pnpm skipped: nothing they run changed since the last green commit"
    return 0
  fi
  if [ "$(uname -s)" != Darwin ]; then
    echo "ci-local: the install tests with a corepack pnpm skipped: they run on a Mac only"
    return 0
  fi
  pnpm test:corepack-install
}
# The two halves of the bridge suite (test-parallel.ts). A commit forked before that runner existed has only the plain one, so
# the first half does nothing and the second runs all of it.
BUN_RUNNER=apps/bridge/scripts/test-parallel.ts SLOW_PREFIX=test/schedules/
# No failed file runs once more: the runner is never given --retry-failed (scripts/ci-no-retries.test.ts).
step_bun_schedules() {
  [ ! -f "$BUN_RUNNER" ] || bun run "$BUN_RUNNER" --jobs "$CI_SCHED_JOBS" --only "$SLOW_PREFIX"
}
step_bun_rest() {
  if [ -f "$BUN_RUNNER" ]; then bun run "$BUN_RUNNER" --jobs "$CI_WORKERS" --skip "$SLOW_PREFIX"; else pnpm test:bun; fi
}
# Chronos's own suite (apps/chronos), by Chronos's own runner: tests/run.sh runs each test file by itself, as Chronos has always run
# it (a bare `python3 -m unittest` in apps/chronos finds no test). Its tests wait on real clocks and processes, so it runs in the
# quiet hold. Python 3.9+, which Chronos needs: an older or missing python3 skips it with a line saying so, never a red. A commit
# from before apps/chronos has none. No CHRONOS_PR_BASE is set, so the test that scans a PR's range skips (a verdict that changed
# with where it ran). Its seconds go to $RESULTS/chronos.secs, a column of timings.tsv; the step's time is in the log as any step's.
step_chronos() {
  local t rc
  if [ ! -f apps/chronos/tests/run.sh ]; then
    echo "ci-local: the Chronos suite skipped: this commit has no apps/chronos"
    return 0
  fi
  if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
    local have="python3 not found"
    ! command -v python3 > /dev/null || have="$(python3 --version 2>&1)"
    echo "ci-local: the Chronos suite skipped: python3 3.9 or newer is needed here ($have)"
    return 0
  fi
  t=$(date +%s)
  env -u CHRONOS_PR_BASE bash apps/chronos/tests/run.sh
  rc=$?
  echo "$(($(date +%s) - t))" > "$RESULTS/chronos.secs"
  return $rc
}
# the contract suite is a Vitest run of its own (apps/bridge): its tests go in check's per-test file too
step_contract() { pnpm --filter @talos-app/bridge test:contract --retry=0 --reporter=default --reporter="$ROOT/scripts/ci-test-results-vitest.ts" "$@"; }

# One thing at a time where a test waits on real time. The contract suite and the schedules tests give a real bridge and the real
# Chronos CLI 3 seconds to answer, and every way of running them beside anything else failed on some run (docs/CI-LOCAL.md has
# the list). So each group, and each Swift job, holds the `suites` mutex: one at a time across all CI runs (slot 1), and while the quiet group runs no new gate starts (scripts/ci-local/locks.sh, ci_quiet_active).
# Each hold of the suites mutex leaves a marker when it was had (suites-quiet, suites-loud), and quiet-ok when the quiet group
# passed: check as a part tells "not tested" (a hold not had in time) from a red (job_check).
quiet_suites() {
  : > "$RESULTS/suites-quiet"
  ci_quiet_begin "$LOCKS" # no new gate starts while this runs (ci_mutex); its end is a row in logs/quiet-group.tsv
  run "$1" step_contract && run "$1" step_bun_schedules
  local rc=$?
  # Chronos's suite after them, whatever they said: a red contract suite must not hide a red Chronos test (or the other way round)
  run "$1" step_chronos || rc=1
  ci_quiet_end "$LOCKS" "$rc"
  [ "$rc" != 0 ] || : > "$RESULTS/quiet-ok"
  : > "$RESULTS/quiet-done"
  return $rc
}
# the corepack variant is in the same hold (a second take of the mutex that was not had in time would read as a red), after the
# suites that run side by side
loud_suites() { : > "$RESULTS/suites-loud"; together "$1" step_bun_rest step_vitest && run "$1" step_corepack_install; }

# The parts of check that run on another machine (docs/CI-MACHINES.md, "check in three places"), posted as ci-part/<job> and
# folded into local-ci/check by the machine that runs check; and the report-only Linux job (report-ci/linux, Hestia). Each is a
# piece of today's check, run the same way: bridge-shard-K is half of the "rest" bridge files (test-parallel.ts --shard K/2, the
# commit's own runner; the main shell drops a shard part for a commit whose runner has no --shard), vitest is the root suite as
# step_vitest runs it. CI_PART_JOBS and CI_PART_WORKERS are the machine's own process and worker counts (its runner's .env).
# The plan's tools for each shard's machine (CI_SHARD_TOOLS), handed to the commit's runner when it knows --pile-tools: the same
# on every machine, so every machine deals the same piles.
pile_tools() { [ -z "${CI_SHARD_TOOLS:-}" ] || ! grep -q -- '--pile-tools' "$BUN_RUNNER" 2>/dev/null || echo --pile-tools "$CI_SHARD_TOOLS"; }
part_tools_ok() { # part_tools_ok <log> <K>: this machine has every tool its pile needs, or the part is refused (an error)
  local need t
  [ -n "$(pile_tools)" ] || return 0
  need="$(bun run "$BUN_RUNNER" --skip "$SLOW_PREFIX" --shard "$2/2" $(pile_tools) --needs 2>>"$1")" || return 1
  for t in $need; do
    case "$t" in tmux) ! ci_tmux_ok || continue; t="tmux 3.2+" ;; esac
    echo "bridge-shard-$2 needs $t, which $WHERE does not have; it runs on Lemnos" | tee -a "$1" > "$RESULTS/bridge-shard-$2.refused"
    return 1
  done
}
part_bridge_shard() { # part_bridge_shard <log> <K>
  setup_ok "$1" &&
  job_tmp "bridge-shard-$2" &&
  part_tools_ok "$1" "$2" &&
  run "$1" bun run "$BUN_RUNNER" --jobs "${CI_PART_JOBS:-$CI_WORKERS}" --skip "$SLOW_PREFIX" --shard "$2/2" $(pile_tools)
}
job_bridge-shard-1() { part_bridge_shard "$1" 1; }
job_bridge-shard-2() { part_bridge_shard "$1" 2; }
job_vitest() {
  local log="$1"
  setup_ok "$log" &&
  job_tmp vitest &&
  CI_WORKERS="${CI_PART_WORKERS:-$CI_WORKERS}" run "$log" step_vitest
}
# Real Linux (Hestia): report-only, on its 2 pinned cores. What skips on every Mac runs here: the supervisor's tests, the
# permission hook's fence and clean-shell cases (permission-hook.test.ts, about 70 s here) and the Linux secret store, plus
# history-corrupt.test.ts, and the WSL distro's own tests (windows-distro.test.ts, Vitest: its systemd and root fakes and
# launch.py run as root work on Linux only).
job_linux() {
  local log="$1"
  setup_ok "$log" &&
  job_tmp linux &&
  run "$log" bun run "$BUN_RUNNER" --jobs 2 --only test/supervisor/ &&
  run "$log" bun run "$BUN_RUNNER" --jobs 2 --only test/permission-hook.test.ts &&
  run "$log" bun run "$BUN_RUNNER" --jobs 2 --only test/secrets-store.test.ts &&
  run "$log" bun run "$BUN_RUNNER" --jobs 2 --only test/history-corrupt.test.ts &&
  run "$log" pnpm exec vitest run --project scripts scripts/windows-distro.test.ts --retry=0 &&
  run "$log" step_linux_only_scripts
}
# The script tests that only run on Linux (they skip on every Mac, so CI on Lemnos never runs them): picked by their own skip
# condition, named in the log, and none may skip whole here (scripts/ci-no-silent-skip.ts). A change broke the shared heavy lock's
# timeout with every status green because nothing ran these (2026-11-14).
LINUX_ONLY_SCRIPTS_RE="runIf\(process\.platform === 'linux'|skipIf\(linuxOnly|skipIf\(!hasFlock|command -v flock|skipIf\(!existsSync\('/proc/"
linux_only_scripts() { grep -lE "$LINUX_ONLY_SCRIPTS_RE" scripts/*.test.ts 2>/dev/null | grep -vx 'scripts/windows-distro.test.ts' | sort; }
step_linux_only_scripts() {
  local files out rc
  files="$(linux_only_scripts | tr '\n' ' ')"
  echo "the script tests that skip on macOS, run here: ${files:-none}"
  [ -n "$files" ] || return 0
  out="$(mktemp)"
  # shellcheck disable=SC2086 # file names, one word each
  pnpm exec vitest run --project scripts $files --retry=0 --reporter=default --reporter="$ROOT/scripts/ci-no-silent-skip.ts" > "$out" 2>&1
  rc=$?
  cat "$out"
  # These files skip nothing on Linux (their skips are all "not on a Mac" or "no flock"): one test skipped here is a condition
  # gone wrong or a tool missing on this box, and a file with no count line never ran. Either fails the step.
  local f line bad=""
  for f in $files; do
    line="$(grep -m1 "^no-silent-skip: $f: " "$out")"
    case "$line" in
      '') bad="$bad $f (no count: it never ran)" ;;
      *": "*" of "*" ran")
        local ran all
        ran="$(printf '%s' "$line" | sed -E 's/.*: ([0-9]+) of ([0-9]+) ran$/\1/')"
        all="$(printf '%s' "$line" | sed -E 's/.*: ([0-9]+) of ([0-9]+) ran$/\2/')"
        [ "$ran" = "$all" ] && [ "$all" -gt 0 ] || bad="$bad $f ($ran of $all ran)"
        ;;
    esac
  done
  if [ -n "$bad" ]; then
    echo "skipped on this Linux box:$bad"
    rc=1
  fi
  rm -f "$out"
  return $rc
}

# report-ci/fast: typecheck, lint and the unit tests (every Vitest project but scripts/, the CI and install suites) that the change
# since check's last pass can reach (vitest --changed, by imports; a change to package.json or the Vitest config reruns all of
# them), so a push gets an answer in about 3 minutes while the six jobs run. With no such pass (a rerun, --full, none in reach)
# it runs typecheck and lint only: every unit test took 470 s on 2 workers at nice 15 on a loaded Mac, a second copy of check's. It is not one of the six (the verdict ignores report-ci/*) and adds
# nothing to them: check runs all of it again. It costs the run little: it takes no mutex and no slot of its own (it never
# waits for the suites, and never holds them up), every step runs at nice 15 so the run's own jobs come first for the CPU, and
# Vitest gets CI_FAST_WORKERS workers (2). The install and build are the run's one setup.
job_fast() {
  local log="$1"
  setup_ok "$log" &&
  job_tmp fast &&
  run "$log" nice -n 15 pnpm typecheck &&
  run "$log" nice -n 15 pnpm lint || return 1
  # Without check's last pass (a rerun, --full, none in reach) the unit tests would be a second full copy of check's own, beside
  # its suites: typecheck and lint only. With it, no retry, as in check (step_vitest).
  if [ -z "$FAST_BASE" ]; then echo "no pass of check to compare with: typecheck and lint only" >> "$log"; return 0; fi
  run "$log" nice -n 15 pnpm exec vitest run --project protocol --project testkit --project integrations --project relay \
    --project web --project mobile --maxWorkers="${CI_FAST_WORKERS:-2}" --changed "$FAST_BASE" \
    --retry=0 --reporter=default --reporter="$ROOT/scripts/ci-flake-vitest.ts"
}

# check as a part (CI_STATUS_PREFIX ci-part or report-ci: Titan's check-titan job, docs/CI-MACHINES.md, "check on Titan"): what
# kept it from testing is "not tested" (an error, which Lemnos takes back and runs itself), never a red: a failed setup, or the
# suites mutex not had in time. A red test, typecheck or lint is a red as ever.
check_part() { [ "${CI_STATUS_PREFIX:-local-ci}" != local-ci ]; }
job_check() {
  local log="$1"
  # CI_CHECK_PART_REFUSE=1 (a manual dispatch only): the part says "not tested" at once, so Lemnos's take-back can be proved
  # on demand. Ignored for local-ci/check: Lemnos's own check never refuses.
  if check_part && [ "${CI_CHECK_PART_REFUSE:-0}" = 1 ]; then
    echo "not tested: forced (CI_CHECK_PART_REFUSE=1, a manual dispatch)" | tee -a "$log" > "$RESULTS/check.refused"
    return 1
  fi
  if ! setup_ok "$log"; then
    ! check_part || echo "not tested: setup failed on $WHERE" | tee -a "$log" > "$RESULTS/check.refused"
    return 1
  fi
  job_tmp check || return 1
  if [ -n "${CI_CHECK_PART:-}" ]; then check_with_part "$log"; else check_today "$log"; fi
}
# Today's check, step for step: also what a take-back runs (check_with_part).
check_today() {
  local log="$1" rc=0
  warn_step check "$log" "personal data found (a warning by default)" pnpm check:personal &&
  run "$log" pnpm typecheck &&
  run "$log" pnpm typecheck:mod &&
  run "$log" pnpm lint &&
  run "$log" pnpm notices:check || rc=1
  if [ "$rc" = 0 ]; then
    suites_then_audit "$log" || rc=1
    # the quiet hold never had, or the quiet group passed and the loud hold never had (a heavy run took the lock in between)
    if [ "$rc" != 0 ] && check_part && { [ ! -f "$RESULTS/suites-quiet" ] ||
      { [ -f "$RESULTS/quiet-ok" ] && [ ! -f "$RESULTS/suites-loud" ]; }; }; then
      echo "not tested: the suites lock was not had in time on $WHERE" | tee -a "$log" > "$RESULTS/check.refused"
    fi
  fi
  # with parts on other machines (CI_REMOTE_PARTS) their tests are not here: the file says which, so a shadow join knows
  local elsewhere=""
  if [ -f "$RESULTS/parts-wanted" ]; then
    elsewhere="$(while read -r p m; do grep -qx "$p" "$RESULTS/parts-taken" 2>/dev/null || printf '%s:%s ' "$p" "$m"; done < "$RESULTS/parts-wanted")"
  fi
  # shellcheck disable=SC2086 # <part>:<machine> words, one argument each
  check_tests_file "$log" $elsewhere
  return "$rc"
}
# every test that ran, red or green, partway or whole (scripts/ci-test-results.ts): Titan's part and Lemnos's check compare it
check_tests_file() { # check_tests_file <log> [<part>:<machine> ...]
  local log="$1"
  shift
  run "$log" bun "$ROOT/scripts/ci-test-results.ts" "$CI_TEST_RESULTS_DIR" "$CACHE/logs/$SHORT-check-tests.tsv" "$SHA" "$WHERE" "$@" ||
    echo "warning: no per-test file (scripts/ci-test-results.ts failed)" >> "$log"
}

# The suites decide the job. The audit always runs after them and only warns: an advisory, or the registry being down, says
# nothing about this commit's code, and a red test must not hide an advisory. It looks at high and critical advisories only.
# ---------- check's parts on other machines (docs/CI-MACHINES.md, "check in three places") ----------
# When the run was given parts (RESULTS/parts-wanted, "<part> <machine>" lines, written by the main shell, which keeps
# RESULTS/part-state-<part> up to date: pass, fail, working, gone), the quiet group and the loud group are one hold of the
# suites mutex: at its end the first look takes every part that is gone (its machine never picked it up, or ended without an
# answer) and runs it here. The second look waits, without the mutex, up to CI_PART_WAIT (120 s) for
# the parts still working, then takes those too. A part that failed on its machine fails check.
PARTS="bridge-shard-1 bridge-shard-2 vitest"
part_state() { cat "$RESULTS/part-state-$1" 2>/dev/null || echo gone; }
part_label() { case "$1" in bridge-shard-*) echo "shard ${1#bridge-shard-}" ;; *) echo "$1" ;; esac; }
part_machine() { awk -v p="$1" '$1 == p { print $2 }' "$RESULTS/parts-wanted"; }
# ---------- a part queued for a lock on its own machine (docs/CI-MACHINES.md, "A part queued for a lock") ----------
# The part says it waits: its pending status reads "waiting for lock: <n>s on <machine> (beat <b>s): <what>", posted again at each
# beat with <n> grown, and "running on <machine>" once it has the lock. The run that folds the part (the main shell, with the token,
# polls it) reads that as a state of its own, "queued <total> <what>": alive, so the part's answer wait does not run while it lasts (the
# folding loops add that time to their deadline). <total> is every wait of the part so far: the <n> of the one going on and of each
# that ended (a "running on" between, or a lower <n> than the last look), because check holds the suites lock twice and a part
# may queue for each. Past CI_PART_LOCK_WAIT_MAX of <total> the state is "stuck <total> <what>" and the part is taken back at once.
# The cap is shorter than the part's job may run (ci-runner.yml: scripts/ci-runner.test.ts checks that the part's run step, its job and
# Lemnos's own run step outlast it), or GitHub would stop the part first and Lemnos would only ever see "gone". The heartbeat is the
# words changing between two polls: unchanged for longer than the part's own beat (<b>, from its words, 10 to 300 s: Lemnos reads no
# beat setting of its own) plus a poll and 30 s, or CI_PART_BEAT_STALE seconds, it is gone and the part counts as only working.
# No clock of the other machine is read. Every number read in arithmetic goes through 10#: "08" is eight, not a bad octal.
CI_PART_LOCK_WAIT_MAX="${CI_PART_LOCK_WAIT_MAX:-2700}"
PART_LOCK_SAYS="waiting for lock: "
part_beat_secs() { echo $((10#${CI_PART_BEAT:-30})); } # the part's beat: never under 10 s (ci-local.sh refuses it). Tests replace this function, never set a lower knob
part_beat_post() { # the part's side, once a second from the main shell: a pending status for each job still running that waits for a lock
  local j f since last what n now beat b fresh="${CI_POLL%.*}"
  [ "$STATUS" = 1 ] && [ "${CI_STATUS_PREFIX:-local-ci}" = ci-part ] || return 0
  # Nothing to look at (no job writes a lock wait, none has a wait posted): no $(...) at all, once a second for the whole run. Each
  # one is a moment where a cancel's trap can be lost (the main loop, after its done).
  for j in $WAITING; do { [ -e "$RESULTS/$j.lockwait" ] || [ -e "$RESULTS/$j.beat" ]; } && break; j=""; done
  [ -n "${j:-}" ] || return 0
  # two statements, never `now=$(...) beat="$(...)"`: a TERM that lands in the first $(...) of one assignment list makes bash 5.2 run
  # the trap inside the second one's parse, where it fails, and the whole loop the call is in is cut off (the main loop, after its done)
  now=$(date +%s)
  beat="$(part_beat_secs)"
  fresh=$((2 * 10#${fresh:-0})) && [ "$fresh" -ge 30 ] || fresh=30
  for j in $WAITING; do # the jobs that have not been reported: a job killed in its wait leaves no result file, and its failure is the last word
    f="$RESULTS/$j.lockwait" b="$RESULTS/$j.beat"
    # a beat of the job's own older than two of its polls (30 s at least) is a wait that ended some other way (a killed step): no wait
    if IFS=$'\t' read -r since last what 2>/dev/null < "$f" && [[ "$since" =~ ^[0-9]+$ && "$last" =~ ^[0-9]+$ ]] && [ $((now - last)) -le "$fresh" ]; then
      n=$((now - since))
      # a short wait posts nothing (two statuses for each second of queue); a long one, one a beat
      [ "$n" -ge "$beat" ] && [ $((now - $(cat "$b" 2>/dev/null || echo 0))) -ge "$beat" ] || continue
      ci_post_status "$SLUG" "$SHA" "$j" pending "$(printf '%s%ss on %s (beat %ss): %s' "$PART_LOCK_SAYS" "$n" "$WHERE" "$beat" "$what" | cut -c1-140)" "${CI_STATUS_URL:-}" || true
      echo "$now" > "$b"
    elif [ -f "$b" ]; then # it posted a wait, and the wait is over
      rm -f "$b"
      ci_post_status "$SLUG" "$SHA" "$j" pending "running on $WHERE" "${CI_STATUS_URL:-}" || true
    fi
  done
}
wait_cut() { # wait_cut <what was waited for>: a wait was cut off, so it never got what it waited for: ended as cancelled, never gone on from
  # Bash 5.2 can run an INT or TERM trap that comes due while the shell is parsing a $(...) in the middle of that parse; the trap
  # then fails ("unexpected EOF while looking for matching `)'": no cancelled marker, no exit 130) and the same error cuts off the
  # command it was in, and the script goes on after it: past the wait for a slot with none, past the wait for the commit's lock
  # without it, or (the main loop) as if every job had ended (an "all green" with jobs unreported, and a record settled as "ended
  # before this job reported"). An error in the wait's own steps cuts it the same way. Say so as the trap would have (the record,
  # when the run has one, and 130), and never go on.
  echo "::error::ci-local: the wait for $1 was cut off (a stop whose trap the shell lost, or an error in the loop); ending as cancelled" >&2
  [ -z "$RUN_DIR" ] || { : > "$RUN_DIR/cancelled"; } 2>/dev/null
  exit 130
}
wait_cut_off() { wait_cut "the jobs, with${WAITING} unreported,"; } # the main loop is over with jobs still unreported (WAITING)
wait_cut_unless() { # wait_cut_unless <lock> <what waited for>: right after a wait, this run must own the lock the wait was for, and have
  # it in CI_HELD (the last thing ci_lock_try does: a take cut off before it is not whole, and its cleanup would not know it)
  local o="" # read, not $(cat), and a case, not a grep: the check itself has no $(...) for a stop to cut (see wait_cut)
  IFS= read -r -d '' o < "$1/owner" 2>/dev/null
  [ "$o" = "$CI_ME" ] || wait_cut "$2"
  case $'\n'"$CI_HELD" in *$'\n'"$1"$'\n'*) ;; *) wait_cut "$2" ;; esac
}
part_lock_ended() { # part_lock_ended <seen file>: the wait it last saw is over: its seconds join the part's total, and the next wait starts clean
  local seen n
  [ -f "$1" ] || return 0
  seen="$(cat "$1")" n="${seen%%s on *}" n="${n#"$PART_LOCK_SAYS"}"
  case "$n" in '' | *[!0-9]*) ;; *) echo $((10#$(cat "$1.done" 2>/dev/null || echo 0) + 10#$n)) > "$1.done" ;; esac
  rm -f "$1"
}
part_lockwait() { # part_lockwait <its rows: "state<TAB>description", newest first> <seen file>: "queued <total> <what>", "stuck <total> <what>" or "working"
  local top desc n b what rest tail now seen last stale poll="${CI_PART_POLL:-30}" sn total
  top="$(printf '%s\n' "$1" | head -1)"
  case "$top" in "pending"$'\t'"$PART_LOCK_SAYS"*) ;; *) part_lock_ended "$2"; echo working; return 0 ;; esac
  desc="${top#pending$'\t'$PART_LOCK_SAYS}"
  n="${desc%%s on *}" rest="${desc#*s on }" b=30
  case "$n" in '' | *[!0-9]*) echo working; return 0 ;; esac
  if [[ "$rest" == *" (beat "*"s): "* ]]; then
    tail="${rest#* (beat }" b="${tail%%s): *}" what="${tail#*s): }"
    case "$b" in '' | *[!0-9]*) b=30 ;; *) b=$((10#$b)); [ "$b" -ge 10 ] || b=10; [ "$b" -le 300 ] || b=300 ;; esac
  else what="${rest#*: }"; fi
  now=$(date +%s)
  seen="$(cat "$2" 2>/dev/null)"
  sn="${seen%%s on *}"
  # a lower <n> than the last look: the wait before it ended, and another has begun
  case "$sn" in '' | *[!0-9]*) ;; *) if [ $((10#$n)) -lt $((10#$sn)) ]; then part_lock_ended "$2"; seen=""; fi ;; esac
  if [ "${seen%%$'\t'*}" = "$desc" ]; then last="${seen##*$'\t'}"; else last=$now; printf '%s\t%s\n' "$desc" "$now" > "$2"; fi
  poll="${poll%.*}"
  stale="${CI_PART_BEAT_STALE:-$((b + 10#${poll:-0} + 30))}" # the part's beat, a poll to see it, and 30 s of slack
  [ $((now - last)) -le "$stale" ] || { echo working; return 0; } # its words did not change: nobody beats
  total=$((10#$(cat "$2.done" 2>/dev/null || echo 0) + 10#$n))
  if [ "$total" -gt "$CI_PART_LOCK_WAIT_MAX" ]; then echo "stuck $total $what"; else echo "queued $total $what"; fi
}
part_stuck_why() { # part_stuck_why <"stuck <total> <what>"> <machine>: for the log and the status of the take-back
  local _ n what
  read -r _ n what <<< "$1"
  echo "waiting for a lock on $2 for ${n}s in all, over CI_PART_LOCK_WAIT_MAX (${CI_PART_LOCK_WAIT_MAX}s): $what"
}
step_bun_shard1() { bun run "$BUN_RUNNER" --jobs "$CI_WORKERS" --skip "$SLOW_PREFIX" --shard 1/2 $(pile_tools); }
step_bun_shard2() { bun run "$BUN_RUNNER" --jobs "$CI_WORKERS" --skip "$SLOW_PREFIX" --shard 2/2 $(pile_tools); }
parts_here() { # parts_here <log> <part...>: those parts side by side, here
  local log="$1" steps=() s1=0 s2=0 p
  shift
  for p in "$@"; do case "$p" in bridge-shard-1) s1=1 ;; bridge-shard-2) s2=1 ;; vitest) steps+=(step_vitest) ;; esac; done
  # both halves, or a commit whose runner cannot split: the whole rest, as today
  if [ "$s1$s2" = 11 ] || { [ "$s1$s2" != 00 ] && ! grep -q -- '--shard' "$BUN_RUNNER" 2>/dev/null; }; then steps+=(step_bun_rest)
  elif [ "$s1" = 1 ]; then steps+=(step_bun_shard1)
  elif [ "$s2" = 1 ]; then steps+=(step_bun_shard2); fi
  [ ${#steps[@]} -gt 0 ] || return 0
  together "$log" "${steps[@]}"
}
quiet_and_parts() { # under the suites mutex: the quiet group, then the first look
  local log="$1" here=() p
  quiet_suites "$log" || return 1
  for p in $PARTS; do
    if [ -z "$(part_machine "$p")" ] || [ "$(part_state "$p")" = gone ]; then here+=("$p"); fi
  done
  # a commit whose runner cannot split runs the whole rest for either half: both halves are then done here
  if ! grep -q -- '--shard' "$BUN_RUNNER" 2>/dev/null && printf '%s\n' ${here[@]+"${here[@]}"} | grep -q '^bridge-shard-'; then
    for p in bridge-shard-1 bridge-shard-2; do printf '%s\n' ${here[@]+"${here[@]}"} | grep -qx "$p" || here+=("$p"); done
  fi
  printf '%s\n' ${here[@]+"${here[@]}"} > "$RESULTS/parts-taken"
  parts_here "$log" ${here[@]+"${here[@]}"} && run "$log" step_corepack_install
}
parts_second_look() { # without the mutex: wait for the parts still working, take the late ones, then fold the answers in
  # Each part has its own wait: CI_PART_WAIT from the start, and the seconds that part spent queued for a lock on its machine (above)
  # added to it. One shard's queue is never another's time. (bash 3.2: parallel arrays, no associative one.)
  local log="$1" start late=() slow=() p m st where="" bad="" now prev i todo=() extra=() todo2=() extra2=()
  start=$(date +%s) prev=$start
  ci_fold_wait "$RESULTS" check # waiting for parts on other machines: no heavy step of this job until one is taken here (turn.sh)
  for p in $PARTS; do
    [ -n "$(part_machine "$p")" ] && ! grep -qx "$p" "$RESULTS/parts-taken" || continue
    todo+=("$p") extra+=(0)
  done
  while [ ${#todo[@]} -gt 0 ]; do
    now=$(date +%s) todo2=() extra2=()
    for i in "${!todo[@]}"; do
      p="${todo[$i]}" st="$(part_state "${todo[$i]}")"
      case "$st" in queued*) extra[i]=$((extra[i] + now - prev)) ;; esac
      case "$st" in
        pass | fail) continue ;;
        stuck*) late+=("$p"); echo "ci-local: taking $p: $(part_stuck_why "$st" "$(part_machine "$p")")" >> "$log" ;;
        working | queued*) if [ "$now" -lt $((start + 10#${CI_PART_WAIT:-120} + extra[i])) ]; then todo2+=("$p") extra2+=("${extra[$i]}"); continue; fi # 10#: "08" is eight seconds, not a bad octal
          late+=("$p"); slow+=("$p") ;;
        *) late+=("$p"); slow+=("$p") ;;
      esac
      echo "$p" >> "$RESULTS/parts-taken"
    done
    prev=$now
    todo=(${todo2[@]+"${todo2[@]}"}) extra=(${extra2[@]+"${extra2[@]}"})
    [ ${#todo[@]} -eq 0 ] || sleep 1
  done
  if [ ${#late[@]} -gt 0 ]; then
    ci_fold_resume "$RESULTS" check "$LOCKS" # taken here: heavy work again, the turn first
    [ ${#slow[@]} -eq 0 ] || echo "ci-local: taking ${slow[*]}: no answer within ${CI_PART_WAIT:-120}s" >> "$log"
    run "$log" ci_mutex "$LOCKS" suites parts_here "$log" "${late[@]}" || return 1
  else ci_fold_end "$RESULTS" check; fi
  # where each part ran, for the status text; a part red on its machine fails check
  for m in $(awk '{ print $2 }' "$RESULTS/parts-wanted" | awk '!seen[$0]++'); do
    local mine=""
    for p in $PARTS; do
      [ "$(part_machine "$p")" = "$m" ] && ! grep -qx "$p" "$RESULTS/parts-taken" || continue
      mine="${mine:+$mine and }$(part_label "$p")"
      [ "$(part_state "$p")" != fail ] || bad="${bad:-$(part_label "$p" | sed 's/^shard/bridge shard/') failed on $m; see its run}"
    done
    [ -z "$mine" ] || where="${where:+$where, }$mine on $m"
  done
  for p in $PARTS; do
    m="$(part_machine "$p")"
    [ -n "$m" ] && grep -qx "$p" "$RESULTS/parts-taken" || continue
    where="${where:+$where, }$(part_label "$p") here: $m did not answer"
  done
  printf '%s\n' "$where" > "$RESULTS/check.where"
  if [ -n "$bad" ]; then echo "$bad" | tee -a "$log" > "$RESULTS/check.why"; return 1; fi
}
suites_then_audit() {
  local log="$1" rc=0
  if [ -f "$RESULTS/parts-wanted" ]; then
    { run "$log" ci_mutex_all "$LOCKS" suites quiet_and_parts "$log" && parts_second_look "$log"; } || rc=1
  else
    { run "$log" ci_mutex_all "$LOCKS" suites quiet_suites "$log" &&
      run "$log" ci_mutex "$LOCKS" suites loud_suites "$log"; } || rc=1
  fi
  warn_step check "$log" "a high or critical advisory, or the registry did not answer" pnpm audit --prod --audit-level high
  return "$rc"
}

# ---------- check on Titan (CI_CHECK_PART; docs/CI-MACHINES.md, "check on Titan") ----------
# CI_TITAN_CHECK=on: Titan's Linux runner runs the whole check as ci-part/check (its job named CI_CHECK_PART). Here check runs
# only the tests that mean something on macOS alone (scripts/ci-local/macos-only.sh: Titan's Linux skips them), under the
# suites mutex, then folds the part in, the way browser folds its e2e part: its green or red is check's. It takes the whole of
# today's check back (check_today, exactly) when the part refused or said "not tested" (an error under its own link), its job
# ended without an answer, or it has none CI_CHECK_WAIT seconds after this run's other jobs end; the status then says so. The
# main shell polls the part into $RESULTS/check-part-state (this job has no token). The subset is this run's quiet group: it
# runs alone beside the Swift jobs' and browser's heavy steps, never at the same time. They wait for quiet-done (wait_for_job
# check quiet-done), written when the subset has ended, pass or fail: its tests give a real bridge a 20 s limit, and beside a
# Swift build and Playwright (load 40-60 on 18 cores) they timed out across unrelated files (docs/CI-LOCAL.md, "The macOS-only
# subset and the machine's load"). Its cost: the Swift jobs start when it ends (about 6 min) and are shorter by about as much.
step_macos_subset() { # each file through check's own runner (scripts/ci-local/macos-only.sh), with check's env and reporters,
  # so its per-test file has them. The bun files: one test-parallel call per file (its --only takes one prefix), the schedules
  # files first, one at a time and alone (as the quiet group runs them), then the rest CI_WORKERS at a time. Then the Vitest
  # files in one run (step_vitest), and the contract files (step_contract, run in apps/bridge: its paths from there, or its
  # filter matches nothing and --passWithNoTests passes it); --passWithNoTests: KIT_SKIP may leave out them all.
  local list bun vitest contract rc=0 f
  list="$(bash "$CI_LOCAL_LIB/macos-only.sh" .)" || { echo "the macOS-only tests could not be listed"; return 1; }
  macos_pick() { printf '%s\n' "$list" | awk -v r="$1" '$1 == r { print $2 }'; }
  bun="$(macos_pick bun | sed 's#^apps/bridge/##')" vitest="$(macos_pick vitest)" contract="$(macos_pick contract | sed 's#^apps/bridge/##')"
  echo "the macOS-only tests, here: $(printf '%s' "$list" | awk '{ print $2 }' | tr '\n' ' ')"
  subset_load start
  if [ -n "$bun" ] && [ -f "$BUN_RUNNER" ]; then
    for f in $(printf '%s\n' "$bun" | grep "^$SLOW_PREFIX"); do bun run "$BUN_RUNNER" --jobs 1 --only "$f" || rc=1; done
    printf '%s\n' "$bun" | { grep -v "^$SLOW_PREFIX" || true; } | xargs -P "$CI_WORKERS" -I{} bun run "$BUN_RUNNER" --jobs 1 --only {} || rc=1
  fi
  subset_load "after the bun files"
  # shellcheck disable=SC2086 # file names, one word each
  [ -z "$vitest" ] || step_vitest --passWithNoTests $vitest || rc=1
  # shellcheck disable=SC2086
  [ -z "$contract" ] || step_contract --passWithNoTests $contract || rc=1
  step_corepack_install || rc=1 # here, on a Mac: the pnpm a user's Mac has
  subset_load end
  return $rc
}
subset_load() { # subset_load <when>: the machine's load averages (1, 5, 15 minutes) in the log, to read the subset's own load later
  echo "subset load $1: $(LC_ALL=C uptime | sed 's/.*load averages*: //')" # scripts/ci-subset-report.ts reads these lines
}
others_done() { # every other job of this run has ended (its result is there, or its group is gone)
  local j g
  for j in "${WANT[@]}"; do
    [ "$j" != check ] && [ ! -f "$RESULTS/$j" ] || continue
    g="$(cat "$RESULTS/$j.group" 2>/dev/null)"
    [ -n "$g" ] && ! kill -0 "$g" 2>/dev/null || return 1 # not started yet, or still going
  done
}
check_with_part() {
  local log="$1" m="$CI_CHECK_PART" deadline=0 first st why lost="did not answer" now prev poll="${CI_PART_POLL:-30}"
  local subset_rc=0
  run "$log" ci_mutex_all "$LOCKS" suites step_macos_subset || subset_rc=1
  : > "$RESULTS/quiet-done" # the Swift jobs and browser go now, whatever the subset said
  if [ "$subset_rc" != 0 ]; then
    echo "the macOS-only tests failed here (or their lock was not had in time); see the log" > "$RESULTS/check.why"
    check_tests_file "$log" "check:$m"
    return 1
  fi
  # the wait counts from when the other jobs end, and from the main shell's first reading of the part (up to 60 s, or two of
  # its polls), so a short wait still sees an answer that is already there
  poll="${poll%.*}"
  first=$(($(date +%s) + (2 * ${poll:-0} > 60 ? 2 * ${poll:-0} : 60)))
  ci_fold_wait "$RESULTS" check # from here until the part answers or is taken back, no heavy step of this job is going (turn.sh)
  prev=$(date +%s)
  while :; do
    st="$(cat "$RESULTS/check-part-state" 2>/dev/null)"
    now=$(date +%s)
    case "$st" in queued*) [ "$deadline" = 0 ] || deadline=$((deadline + now - prev)) ;; esac # queued for a lock on its machine: not counted
    prev=$now
    if [ "$deadline" = 0 ] && { [ -n "$st" ] || [ "$(date +%s)" -ge "$first" ]; } && others_done; then
      deadline=$(($(date +%s) + 10#$CI_CHECK_WAIT))
    fi
    case "$st" in
      pass) ci_fold_end "$RESULTS" check; echo "check on $m, macOS-only tests here" > "$RESULTS/check.where"; echo "check passed on $m (ci-part/check)" >> "$log"; check_tests_file "$log" "check:$m"; return 0 ;;
      fail) ci_fold_end "$RESULTS" check; echo "check failed on $m; see its run" | tee -a "$log" > "$RESULTS/check.why"; check_tests_file "$log" "check:$m"; return 1 ;;
      gone) why="its job ended without an answer, or it refused"; break ;;
      stuck*) why="$(part_stuck_why "$st" "$m")"; lost="waited too long for a lock"; break ;;
    esac
    [ "$deadline" = 0 ] || [ "$now" -lt "$deadline" ] || { why="no answer within ${CI_CHECK_WAIT}s of this run's other jobs${st:+ ($st)}"; break; }
    sleep 1
  done
  # Taken back: today's check, and its result is check's. A red the part posts before check is posted still fails it (report).
  ci_fold_resume "$RESULTS" check "$LOCKS" # heavy work again: the turn first (waits while a gate holds the machine)
  echo "ci-local: taking check back from $m: $why" >> "$log"
  echo "check here: $m $lost" > "$RESULTS/check.where"
  # the subset's results go: today's check runs those files again, and its per-test file is the whole of check's
  [ -z "${CI_TEST_RESULTS_DIR:-}" ] || { rm -rf "${CI_TEST_RESULTS_DIR:?}" && mkdir -p "$CI_TEST_RESULTS_DIR"; }
  check_today "$log"
}
