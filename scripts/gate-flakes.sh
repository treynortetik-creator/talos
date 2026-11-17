# shellcheck shell=bash
# The gate's rule for known flaky tests: sourced by gate.sh (by way of tstep and rstep in scripts/gate-excuse.sh), which owns say,
# refuse, VITEST_ROOTS and TALOS_TEST_TIME_FACTOR. A test step that fails ONLY on tests listed in scripts/known-flakes.txt (path,
# test name, a named owner, an expiry date) runs each of them once more, ALONE, in the step's own heavy-lock hold. If every one
# passes alone the step passes and says so, one line a test; the rerun is logged in <cache>/logs/flake-reruns.tsv. Anything else
# refuses exactly as before, with no rerun at all: another failure beside the flake, an entry that is expired or has no owner, a
# failure list the gate cannot read (fail closed), a runner it cannot rerun by, a flake that fails alone too.
# The names are the runners' own: gate-excuse.pl reads the step's log (the same reader the excuse for tests red on main uses), so
# a failure it cannot account for, or a count of failures that is not the number of names, is never a flake.

FLAKE_WHY="" # why the last flake_rerun did not pass the step (empty: no failing test was a listed flake, so nothing to add)

# The list is read from the BASE the gate measures the change against (BASE, gate.sh's --base: main as fetched), never from the
# working tree: a change cannot add its own flake, and a new entry counts once it is on main. No base, or no list there: no rerun.
# flake_ready: 0 when the base holds the list and the log reader is here
flake_ready() {
  [ -n "${BASE:-}" ] && [ -f scripts/gate-excuse.pl ] && declare -F excuse_touches >/dev/null &&
    git cat-file -e "$BASE:scripts/known-flakes.txt" 2>/dev/null
}

# flake_date_ok <YYYY-MM-DD>: 0 for a real calendar day (2026-99-99 and 2027-02-29 are not)
flake_date_ok() {
  local y m d max
  case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) return 1 ;; esac
  y=$((10#${1:0:4})) m=$((10#${1:5:2})) d=$((10#${1:8:2}))
  [ "$y" -ge 1 ] && [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] || return 1
  case "$m" in
    1 | 3 | 5 | 7 | 8 | 10 | 12) max=31 ;;
    4 | 6 | 9 | 11) max=30 ;;
    *) if [ $((y % 4)) = 0 ] && { [ $((y % 100)) != 0 ] || [ $((y % 400)) = 0 ]; }; then max=29; else max=28; fi ;;
  esac
  [ "$d" -le "$max" ]
}

# flake_entry <path> <test name>: the base's list lines for that test, "owner<US>until" (US, \037: an owner may be empty); nothing when unlisted
flake_entry() {
  git show "$BASE:scripts/known-flakes.txt" 2>/dev/null |
    P="$1" N="$2" awk -F'\t' '/^#/ { next } $1 == ENVIRON["P"] && $2 == ENVIRON["N"] { print $3 "\037" $4 }'
}

# flake_pattern <test name>: the regex that matches that one test (its parts joined by " > " or by a space, as the runners join a
# describe and a test), escaped, anchored. bun -t joins with a space, vitest with " > ".
flake_pattern() {
  perl -e 'my $n = shift; print "^", join("( > | )", map { (my $p = $_) =~ s/([\\^\$.*+?()\[\]{}|\/])/\\$1/g; $p } split / > /, $n, -1), "\$"' "$1"
}

# flake_limited <seconds> <command...>: the command in a process group of its own; at the limit TERM to the whole group, then KILL;
# a TERM or INT to the gate stops it too. Exit 142 at the limit, the command's own code otherwise (a signal as 128+N).
flake_limited() {
  perl -MPOSIX=WNOHANG,EINTR -e '
    my $lim = shift; my $pid = fork() // die "fork: $!\n";
    if (!$pid) { setpgrp(0, 0); exec @ARGV or die "exec: $!\n" }
    setpgrp($pid, $pid);
    my ($timed, $reaped, $st) = (0, 0, 0);
    my $stop = sub { kill "TERM", -$pid;
      for (1 .. 50) { if (!$reaped && waitpid($pid, WNOHANG) == $pid) { $reaped = 1; $st = $? } last unless kill 0, -$pid; select(undef, undef, undef, 0.1) }
      kill "KILL", -$pid };
    $SIG{ALRM} = sub { $timed = 1; $stop->() };
    $SIG{$_} = sub { $stop->(); exit 143 } for qw(TERM INT HUP);
    alarm $lim;
    until ($reaped) { my $r = waitpid($pid, 0); if ($r == $pid) { $reaped = 1; $st = $? } elsif ($r == -1 && $! != EINTR) { last } }
    alarm 0; kill "KILL", -$pid if kill 0, -$pid;
    exit($timed ? 142 : $st & 127 ? 128 + ($st & 127) : $st >> 8);
  ' "$@"
}

# flake_log <step> <path> <test> <owner> <result>: one line in <cache>/logs/flake-reruns.tsv (UTC time, sha, step, path, test,
# owner, result). Evidence only: a log that cannot be written is said, and changes nothing.
flake_log() {
  local f="${TALOS_CI_CACHE:-${HOME:-/nonexistent}/.cache/talos-ci}/logs/flake-reruns.tsv"
  { mkdir -p "$(dirname "$f")" && printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(git rev-parse HEAD 2>/dev/null || echo unknown)" "$1" "$2" "$3" "$4" "$5" >>"$f"; } 2>/dev/null || say "the flake rerun could not be logged ($f)"
}

# flake_alone <path> <test name>: the test run alone, in the runner it belongs to. 0 only when the runner exits 0 AND says one or
# more tests passed and none failed (a name that matches nothing exits 0 in Vitest: that is not a pass). Its output is shown when it
# fails. A bridge test (apps/bridge/) runs in bun from apps/bridge with the failing step's own per-test limit (FLAKE_BUN_TIMEOUT_MS, set by gate.sh for "bridge files", 5 s x factor;
# else test-parallel's 20 s x factor, which the other bridge steps use); any
# other is a Vitest project's, the project named for the root it is under (VITEST_ROOTS).
flake_alone() {
  local path="$1" test="$2" pat out rc root proj="" lim tmp fac="${TALOS_TEST_TIME_FACTOR:-1}"
  case "$fac" in '' | *[!0-9]* | 0) fac=1 ;; esac
  pat="$(flake_pattern "$test")" || return 1
  out="$(mktemp "${TMPDIR:-/tmp}/gate-flake-XXXXXX")" || return 1
  lim="${GATE_FLAKE_RERUN_LIMIT:-$((300 * fac))}" # the group time limit of one rerun, seconds (test-parallel's file limit)
  case "$lim" in '' | *[!0-9]* | 0) lim=$((300 * fac)) ;; esac
  case "$path" in
    apps/bridge/*)
      # the test's own temp folder, as package.json's test makes it
      tmp="$(mktemp -d "${TMPDIR:-/tmp}/tbrun-XXXXXX")" || { rm -f "$out"; return 1; }
      (cd apps/bridge && TMPDIR="$tmp" flake_limited "$lim" bun test "--timeout=${FLAKE_BUN_TIMEOUT_MS:-$((20000 * fac))}" "./${path#apps/bridge/}" -t "$pat") \
        </dev/null >"$out" 2>&1
      rc=$?
      rm -rf "$tmp"
      ;;
    *)
      # shellcheck disable=SC2086 # the roots, one argument each
      for root in $VITEST_ROOTS; do case "$path" in "$root"/*) proj="${root##*/}" ;; esac; done
      [ -n "$proj" ] || { rm -f "$out"; return 1; }
      flake_limited "$lim" pnpm exec vitest run --project "$proj" "$path" -t "$pat" </dev/null >"$out" 2>&1
      rc=$?
      ;;
  esac
  if [ "$rc" = 0 ]; then
    case "$path" in
      apps/bridge/*) grep -Eq '^ *[1-9][0-9]* pass$' "$out" && grep -Eq '^ *0 fail$' "$out" || rc=1 ;;
      *)
        perl -pe 's/\e\[[0-9;]*m//g' "$out" >"$out.plain"
        { grep -Eq '^ *Tests +[1-9][0-9]* passed' "$out.plain" && ! grep -Eq '^ *Tests .*failed' "$out.plain"; } || rc=1
        rm -f "$out.plain"
        ;;
    esac
  fi
  [ "$rc" = 0 ] || { say "the rerun of $test ($path) alone, exit $rc:"; tail -n 60 "$out" >&2; }
  rm -f "$out"
  [ "$rc" = 0 ]
}

# flake_rerun <log of the failed step> <step name>: 0 when every failure in it is a listed, unexpired flake that then passed alone
# (said, logged); else 1, with FLAKE_WHY saying why when a listed flake was among the failures.
flake_rerun() {
  local log="$1" step="$2" out why how rows="" n f today entries e owner until first="" listed=0 bad="" todo="" passed=0
  FLAKE_WHY=""
  flake_ready || return 1
  # shellcheck disable=SC2086 # the roots, one argument each
  out="$(perl scripts/gate-excuse.pl "$log" $VITEST_ROOTS 2>/dev/null)" || return 1
  why="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "unaccounted" { print $2; exit }')"
  rows="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "test"')"
  [ -n "$rows" ] || return 1
  today="$(date -u +%Y-%m-%d)"
  while IFS=$'\t' read -r _ n f; do
    [ -n "$n" ] || continue
    # Vitest names its file in front ("|scripts| a.test.ts > describe > test"): the list's name is what follows
    n="$(printf '%s' "$n" | perl -pe 's/^(?:\|[^|]+\| )?\S+\.(?:test|spec)\.tsx? > //')"
    entries=""
    [ -z "$f" ] || entries="$(flake_entry "$f" "$n")"
    if [ -z "$entries" ]; then
      [ -n "$bad" ] || bad="$n is not a known flake"
      continue
    fi
    listed=1
    owner="" first="" # the entry to use: one with an owner and a date that has not passed; else why not
    while IFS=$'\037' read -r e until; do
      flake_date_ok "$until" || { first="${first:-$n has an entry with no valid date (until YYYY-MM-DD)}"; continue; }
      case "$(printf '%s' "$e" | tr '[:upper:]' '[:lower:]')" in '' | none | nobody | unknown | tbd | '?' | -) first="${first:-$n has an entry with no named owner}"; continue ;; esac
      if [ "$until" \< "$today" ]; then first="${first:-$n is a known flake whose entry expired $until (owner $e)}"; continue; fi
      owner="$e"
      break
    done <<<"$entries"
    if [ -z "$owner" ]; then
      [ -n "$bad" ] || bad="$first"
      continue
    fi
    # a change that edits the flaky test, or reaches it or the code it names, gets no rerun: a real slowdown there would pass alone
    if how="$(excuse_touches "$f")"; then
      [ -n "$bad" ] || bad="$n ($f) is a known flake, but this change $how"
      continue
    fi
    todo="$todo$f"$'\037'"$n"$'\037'"$owner"$'\n'
  done <<<"$rows"
  [ "$listed" = 1 ] || return 1 # no failing test is a listed flake: as before, and nothing to say
  if [ -n "$why" ]; then FLAKE_WHY="not only named tests failed ($why): nothing was rerun"; return 1; fi
  if [ -n "$bad" ]; then FLAKE_WHY="$bad, so nothing was rerun"; return 1; fi
  # every failure is a listed flake in date: each runs once, alone, and every one must pass (the first that does not ends it)
  while IFS=$'\037' read -r f n owner; do
    [ -n "$n" ] || continue
    if flake_alone "$f" "$n"; then
      flake_log "$step" "$f" "$n" "$owner" passed-alone
      say "known flake $n (owner $owner) failed, passed alone on rerun"
      passed=$((passed + 1))
    else
      flake_log "$step" "$f" "$n" "$owner" failed-alone
      FLAKE_WHY="known flake $n (owner $owner) failed again alone"
      return 1
    fi
  done <<<"$todo"
  say "$step failed only on known flaky tests ($passed), each passed alone on rerun: the step passes"
  return 0
}
