# scripts/ci-local/machine.sh: the machine: sleep and wake, slot environment, memory, network git, time limits, the iOS simulator, tmux, its name. Part of scripts/ci-local.sh, which sources it in place (these lines were there,
# unchanged, and run in the same order). Not run on its own.
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
# ci_git_net <git args...>: a git call that talks to origin (fetch), run here, with stdin from /dev/null and stopped after
# CI_GIT_LIMIT (300 s). When it fails it says which remote and the likely reason, with git's own last line: a run on a machine
# with no credential for the remote fails at once (git may not ask) instead of waiting for ever. The link is printed without
# any user or token in it.
ci_git_net() {
  local rc url err last gd locks="" lim="${CI_GIT_LIMIT:-300}"
  case "$lim" in '' | *[!0-9]* | 0) lim=300 ;; esac
  err="$(mktemp)" || err=/dev/null
  # A perl in front of git: git in a process group of its own, made from both sides (no moment where a stop misses it), and
  # at CI_GIT_LIMIT the whole group (git and its helpers: git-remote-https, a credential helper, ssh) gets TERM, on which git
  # removes its .lock files, then after 5 s KILL. Only that group, which this call made; never by name. The perl is in front,
  # not in the background: it holds the limit even if this shell is killed, and a TERM, INT or HUP it gets is passed on.
  [ "$err" = /dev/null ] || : > "$err.start" # when the call began: a lock file newer than this is the call's (git writes $err)
  perl -MPOSIX=WNOHANG -e '
    my $lim = shift;
    my $pid = fork() // die "fork: $!\n";
    if (!$pid) { setpgrp(0, 0); exec @ARGV or die "exec: $!\n" }
    setpgrp($pid, $pid);
    my ($timed, $reaped, $st) = (0, 0, 0);
    my $stop = sub {
      kill "TERM", -$pid;
      for (1 .. 50) {
        if (!$reaped && waitpid($pid, WNOHANG) == $pid) { $reaped = 1; $st = $? }
        last unless kill 0, -$pid;
        select(undef, undef, undef, 0.1);
      }
      kill "KILL", -$pid;
    };
    $SIG{ALRM} = sub { $timed = 1; $stop->() };
    $SIG{$_} = sub { $stop->(); exit 143 } for qw(TERM INT HUP);
    alarm $lim;
    until ($reaped) {
      my $r = waitpid($pid, 0);
      if ($r == $pid) { $reaped = 1; $st = $? } elsif ($r == -1 && $!{ECHILD}) { last }
    }
    alarm 0;
    exit 142 if $timed;
    exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
  ' "$lim" git "$@" < /dev/null 2> "$err"
  rc=$?
  if [ "$rc" = 142 ] && [ "$err" != /dev/null ]; then
    # a lock file the call left (made after it began): named, not removed, since another git may own it. Both git dirs: in a
    # linked worktree shallow.lock, packed-refs.lock and the ref locks are in the common one.
    for gd in "$(git rev-parse --absolute-git-dir 2>/dev/null)" "$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"; do
      [ -n "$gd" ] && [ -d "$gd" ] || continue
      locks="$locks$(find "$gd" -path "$gd/objects" -prune -o -name '*.lock' -newer "$err.start" -print 2>/dev/null)"$'\n'
    done
    locks="$(printf '%s' "$locks" | sed '/^$/d' | sort -u | tr '\n' ' ')"
  fi
  last="$(tail -1 "$err" 2>/dev/null)"
  [ "$err" = /dev/null ] || rm -f "$err" "$err.start"
  [ "$rc" != 0 ] || return 0
  url="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#')"
  if [ "$rc" = 142 ]; then
    echo "ci-local: git $1 of ${url:-origin} stopped after ${lim}s with no answer: no credential? (git may not ask for one here)${locks:+; it left ${locks% } (not removed: another git may own it)}" >&2
  else
    echo "ci-local: git $1 of ${url:-origin} failed (exit $rc): no credential? (git may not ask for one here)${last:+; git said: $last}" >&2
  fi
  return "$rc"
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
# The desktop job's pty use (two Swift suites at once exhausted them: kern.tty.ptmx_max is 511 on Lemnos, one test process peaked at
# 437, and tmux then failed with "fork failed: Device not configured"). The machine's whole count of /dev/ttys* (CI_PTY_DEV for the
# tests), looked at every CI_PTY_POLL seconds (2) while the job's command runs; the peak goes to <file>. Nothing can be read: 0.
ci_pty_count() { local n=0 f; for f in "${CI_PTY_DEV:-/dev}"/ttys*; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
ci_pty_max() { sysctl -n kern.tty.ptmx_max 2>/dev/null || echo '?'; }
ci_pty_during() { # ci_pty_during <peak file> <cmd...>: the command's own exit code; the peak count while it ran in <peak file>
  local f="$1" w rc n
  shift
  ci_pty_count > "$f"
  ( # in the job's process group: a cancelled run stops it with the job
    p="$(cat "$f")"
    while :; do
      n="$(ci_pty_count)"
      [ "$n" -le "$p" ] || { p="$n"; echo "$p" > "$f.part" && mv -f "$f.part" "$f"; }
      sleep "${CI_PTY_POLL:-2}"
    done
  ) &
  w=$!
  "$@"
  rc=$?
  kill "$w" 2>/dev/null
  wait "$w" 2>/dev/null
  n="$(ci_pty_count)" # one last look, so a job shorter than a poll still counts what it ended with
  [ "$n" -le "$(cat "$f")" ] || echo "$n" > "$f"
  return $rc
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
