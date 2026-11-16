#!/usr/bin/env bash
# The load and memory guard for one machine: the hook scripts/heavy-lock.sh (and ci-local's suites mutex) calls before a heavy
# job starts, and a way to ask "may I start something heavy now?" for work that is not a Talos job. It LISTS and REFUSES. It
# never stops, signals or reprioritises anyone's process: stopping a job is its owner's act, by pid. The one signal it sends
# is to its own probe, when that probe outlives its deadline (bounded, below).
#
#   scripts/heavy-guard.sh <job>                     the hook: 0 = go, 75 = not now (the first line says why)
#                                                    ONE argument is always a job name, except status, --help and -h
#   scripts/heavy-guard.sh check <job>               the same
#   scripts/heavy-guard.sh ask <gb> [who]            may I use <gb> GB now? 0 = go, 75 = not now
#   scripts/heavy-guard.sh book <who> <from> <to> [note...]   reserve a window (HH:MM today, or YYYY-MM-DDTHH:MM)
#   scripts/heavy-guard.sh unbook <who> [<from>]     remove that person's bookings (or the one starting at <from>)
#   scripts/heavy-guard.sh unbook --all --yes        remove every booking (the bookings file)
#   scripts/heavy-guard.sh status                    memory, load, bookings, the heavy lock, the last refusal, possible strays
#   scripts/heavy-guard.sh init <--min-free-pct N | --max-load N | --bookings>...   turn the guard on (writes guard.env)
#   scripts/heavy-guard.sh off --yes                 turn it off (removes guard.env)
#
# Off by default. With no guard.env (in <cache>/guard, cache = TALOS_CI_CACHE or ~/.cache/talos-ci) and none of
# HEAVY_GUARD_MIN_FREE_PCT, HEAVY_GUARD_MAX_LOAD, HEAVY_GUARD_BOOKINGS set, check and the hook answer go without a single
# probe. Each check is on only when its own setting is: the memory floor (HEAVY_GUARD_MIN_FREE_PCT, 1-100), the load limit
# (HEAVY_GUARD_MAX_LOAD, above 0; no default from the core count; for machines that are not CI runners) and bookings
# (HEAVY_GUARD_BOOKINGS=1). The environment wins over guard.env, which is parsed as KEY=value lines, never sourced.
# HEAVY_GUARD_OFF=1 answers go. HEAVY_GUARD_STRAY_MIN (30): minutes before a heavy-looking process outside the lock counts as
# a possible stray in status. HEAVY_GUARD_LOAD_SETTLE_S (300): seconds after the heavy lock last changed hands during which a
# job is not refused for load (the 1-minute load is still the last job's).
#
# Never blocks by mistake: a probe that fails, prints something not understood or outlives its deadline (3 s each, 5 s for the
# whole hook; 5 s each and 15 s in all in status) skips its check; a broken bookings file is no bookings. There is exactly
# ONE `exit 75` (finish), reached only when NOT_NOW is set, and NOT_NOW is set only right after a comparison of two parsed
# numbers (num_lt / num_gt / num_le). Exit codes: 0 go, 75 not now, 64 usage, 65 a refused write.
#
# Probes. With HEAVY_GUARD_TEST=1 (tests only) each takes its value from the variable named, and status says so; without
# it those variables are ignored. An override that is not a number is "unknown", never a fall back to the machine.
#   HEAVY_GUARD_FREE_PCT  memory free %: Linux MemAvailable/MemTotal (/proc/meminfo); macOS memory_pressure's last line
#   HEAVY_GUARD_MEM_GB    total memory: Linux MemTotal; macOS sysctl hw.memsize
#   HEAVY_GUARD_LOAD1     1-minute load: /proc/loadavg, sysctl vm.loadavg, or uptime (both formats)
#   HEAVY_GUARD_CORES     cores: sysctl hw.ncpu, nproc, getconf
#   HEAVY_GUARD_NOW       the clock, epoch seconds: date +%s
#   HEAVY_GUARD_NOW_FILE  the clock from the first line of a file, read at every call (HEAVY_GUARD_NOW wins)
#   HEAVY_GUARD_PROC      not a value: the folder the Linux probes read meminfo and loadavg from, instead of /proc
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
CACHE="${TALOS_CI_CACHE:-${HOME:-/nonexistent}/.cache/talos-ci}"
GDIR="$CACHE/guard"
GENV="$GDIR/guard.env"
BOOKINGS="$GDIR/bookings.tsv"
LAST="$GDIR/last-refusal"
LOCKS="$CACHE/locks"
LOCK_DIR="$LOCKS/mutex-suites"
PROBE_S=3 DEADLINE="" # each probe's limit in seconds, and the epoch by which the hook answers (set in cmd_check / cmd_ask)

# What status calls a possible stray: a fixed substring of the command line. Extend here.
STRAY_PATTERNS='bun test
vitest
playwright
swift-test
swift-build
swiftpm-testing-helper
tmux -L talos-test-
xcodebuild
ollama
llama
mlx'
# Never a stray, whatever else it matches: the live agent server, a tmux whose -L is exactly `talos`.

usage() {
  sed -n "7,16p" "$0" 2>/dev/null | sed 's/^# *//'
}
bad_usage() {
  usage >&2
  exit 64
}

# ---- numbers ---------------------------------------------------------------------------------------------------------------
is_num() { # a plain non-negative decimal, at most 15 characters
  case "$1" in '' | *[!0-9.]* | .* | *. | *.*.*) return 1 ;; esac
  [ "${#1}" -le 15 ]
}
is_int() { case "$1" in '' | *[!0-9]*) return 1 ;; esac; [ "${#1}" -le 15 ]; }
# Each is true ONLY for two parsed numbers that compare so. Anything else (a non-number, perl missing) is false.
num_lt() { is_num "$1" && is_num "$2" && perl -e 'exit(($ARGV[0] < $ARGV[1]) ? 0 : 1)' "$1" "$2" 2>/dev/null; }
num_gt() { is_num "$1" && is_num "$2" && perl -e 'exit(($ARGV[0] > $ARGV[1]) ? 0 : 1)' "$1" "$2" 2>/dev/null; }
num_le() { is_num "$1" && is_num "$2" && perl -e 'exit(($ARGV[0] <= $ARGV[1]) ? 0 : 1)' "$1" "$2" 2>/dev/null; }
fmt() { perl -e '$s = sprintf "%.1f", $ARGV[0]; $s =~ s/\.0$//; print $s' "$1" 2>/dev/null; } # 12.0 -> 12, 37.5 -> 37.5
clean() { printf '%s' "$1" | tr -d '\000-\037\177' 2>/dev/null | cut -c1-"${2:-120}" 2>/dev/null; }
either() { if [ -n "$1" ]; then printf "%s" "$2"; else printf "%s" "$3"; fi; } # either <x> <if set> <if empty>
mtime() { perl -e 'my @s = stat $ARGV[0]; print $s[9] if @s' "$1" 2>/dev/null; }
epoch() { perl -e 'print time' 2>/dev/null; } # the script's own deadlines (not a probe: the bookings clock is probe_now)

# ---- bounded: run a probe with a deadline ----------------------------------------------------------------------------------
# bounded <cmd...>: the probe runs in a process group of its own; its output is passed on only if it finished in time
# (PROBE_S seconds, and never past DEADLINE). A probe still running then is stopped, with its whole group: the guard stopping
# ITS OWN child is the one signal this script ever sends. Exit 124 = timed out (no output), 125 = could not start.
# shellcheck disable=SC2016 # perl code, single-quoted on purpose
BOUNDED='
  my ($secs, $deadline, @cmd) = @ARGV;
  my $left = $secs;
  if (defined $deadline && $deadline =~ /^\d+$/) { my $d = $deadline - time; $left = $d if $d < $left }
  exit 124 if $left <= 0;
  pipe(my $r, my $w) or exit 125;
  my $pid = fork; exit 125 unless defined $pid;
  if (!$pid) { close $r; setpgrp(0, 0); open(STDOUT, ">&", $w); open(STDERR, ">", "/dev/null"); exec @cmd; exit 127 }
  close $w;
  my $out = "";
  my $ok = eval { local $SIG{ALRM} = sub { die "late\n" }; alarm $left; local $/; $out = <$r> // ""; waitpid($pid, 0); alarm 0; 1 };
  if (!$ok) { kill "KILL", -$pid; waitpid($pid, 0); exit 124 }
  print $out; exit($? & 127 ? 128 + ($? & 127) : $? >> 8); # a probe killed by a signal is no pass: 128+n, as the shell says
'
bounded() { perl -e "$BOUNDED" "$PROBE_S" "$DEADLINE" "$@" 2>/dev/null; }

# ---- settings --------------------------------------------------------------------------------------------------------------
S_MIN="" S_LOAD="" S_BOOK="" S_OFF="" S_STRAY="" S_SETTLE="" CONFIGURED="" WHERE=""
read_settings() {
  local line k v
  if [ -f "$GENV" ]; then
    CONFIGURED=1 WHERE="guard.env"
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in HEAVY_GUARD_*=*) ;; *) continue ;; esac
      k="${line%%=*}" v="${line#*=}"
      v="${v#\"}" v="${v%\"}" v="${v#\'}" v="${v%\'}"
      v="$(printf '%s' "$v" | tr -d ' \t\r' 2>/dev/null)"
      case "$k" in
        HEAVY_GUARD_MIN_FREE_PCT) S_MIN="$v" ;;
        HEAVY_GUARD_MAX_LOAD) S_LOAD="$v" ;;
        HEAVY_GUARD_BOOKINGS) S_BOOK="$v" ;;
        HEAVY_GUARD_OFF) S_OFF="$v" ;;
        HEAVY_GUARD_STRAY_MIN) S_STRAY="$v" ;;
        HEAVY_GUARD_LOAD_SETTLE_S) S_SETTLE="$v" ;;
      esac
    done < "$GENV" 2>/dev/null
  fi
  if [ -n "${HEAVY_GUARD_MIN_FREE_PCT+x}${HEAVY_GUARD_MAX_LOAD+x}${HEAVY_GUARD_BOOKINGS+x}" ]; then
    CONFIGURED=1 WHERE="${WHERE:+$WHERE and }the environment"
  fi
  [ -z "${HEAVY_GUARD_MIN_FREE_PCT+x}" ] || S_MIN="$HEAVY_GUARD_MIN_FREE_PCT"
  [ -z "${HEAVY_GUARD_MAX_LOAD+x}" ] || S_LOAD="$HEAVY_GUARD_MAX_LOAD"
  [ -z "${HEAVY_GUARD_BOOKINGS+x}" ] || S_BOOK="$HEAVY_GUARD_BOOKINGS"
  [ -z "${HEAVY_GUARD_OFF+x}" ] || S_OFF="$HEAVY_GUARD_OFF"
  [ -z "${HEAVY_GUARD_STRAY_MIN+x}" ] || S_STRAY="$HEAVY_GUARD_STRAY_MIN"
  [ -z "${HEAVY_GUARD_LOAD_SETTLE_S+x}" ] || S_SETTLE="$HEAVY_GUARD_LOAD_SETTLE_S"
  # a setting that is not valid switches its check off (status says so); it never blocks
  FLOOR="" LIMIT="" BOOK_ON="" STRAY_MIN=30 SETTLE=300
  if is_num "$S_MIN" && num_gt "$S_MIN" 0 && num_le "$S_MIN" 100; then FLOOR="$S_MIN"; fi
  if is_num "$S_LOAD" && num_gt "$S_LOAD" 0; then LIMIT="$S_LOAD"; fi
  [ "$S_BOOK" = 1 ] && BOOK_ON=1
  is_int "$S_STRAY" && STRAY_MIN="$S_STRAY"
  is_int "$S_SETTLE" && SETTLE="$S_SETTLE"
}

# ---- probes (each prints a number, or nothing when unknown) ----------------------------------------------------------------
testing() { [ "${HEAVY_GUARD_TEST:-}" = 1 ]; }
# Where the Linux probes read meminfo and loadavg. HEAVY_GUARD_PROC (tests only, with HEAVY_GUARD_TEST=1) points them at a
# folder of the test's own, so a test of probes that fail or print garbage covers Linux too: there the probes read files, not
# the tools a test can replace on PATH. A missing folder is a Linux machine whose /proc can't be read: the macOS tools are tried.
PROCFS=/proc
if testing && [ -n "${HEAVY_GUARD_PROC:-}" ]; then PROCFS="$HEAVY_GUARD_PROC"; fi
# Test mode is loud: every command that reads the machine (the hook, check, ask, status) ends with a warning on stderr, after its
# answer (a caller reads the answer's first line), so a HEAVY_GUARD_TEST=1 exported by hand and inherited by a real gate can't
# steer it quietly. Nothing in the gate, CI or heavy-lock.sh sets it; the tests pass it to each process they start.
loud() { testing && trap 'echo "heavy-guard: WARNING: HEAVY_GUARD_TEST=1 is set: test overrides are in force, this answer is not the machine'"'"'s" >&2' EXIT; }
overridden() { testing && eval "[ -n \"\${$1+x}\" ]"; } # overridden <var>: a test override is in force for it
override() { # override <var>: 0 if a test override is in force (its value, if a number, is printed); 1 if not
  overridden "$1" || return 1
  local v
  eval "v=\"\${$1}\""
  is_num "$v" && printf '%s' "$v"
  return 0
}
mark() { overridden "$1" && printf ' (test override)'; } # mark <var>: for status
probe_free_pct() {
  local v a t
  if overridden HEAVY_GUARD_FREE_PCT; then
    v="$HEAVY_GUARD_FREE_PCT"
  elif [ -r "$PROCFS/meminfo" ]; then
    a="$(sed -n 's/^MemAvailable: *\([0-9]*\) kB.*/\1/p' "$PROCFS/meminfo" 2>/dev/null)"
    t="$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' "$PROCFS/meminfo" 2>/dev/null)"
    is_int "$a" && is_int "$t" && [ "$t" -gt 0 ] && v=$((a * 100 / t))
  else
    v="$(bounded memory_pressure | sed -n 's/^System-wide memory free percentage: *\([0-9.]*\)%.*/\1/p' 2>/dev/null | tail -1)"
  fi
  is_num "$v" && num_le "$v" 100 && printf '%s' "$v"
}
probe_mem_gb() {
  local v
  override HEAVY_GUARD_MEM_GB && return 0
  if [ -r "$PROCFS/meminfo" ]; then
    v="$(sed -n 's/^MemTotal: *\([0-9]*\) kB.*/\1/p' "$PROCFS/meminfo" 2>/dev/null)"
    is_int "$v" && v="$(perl -e 'printf "%.1f", $ARGV[0] / 1048576' "$v" 2>/dev/null)"
  else
    v="$(bounded sysctl -n hw.memsize)"
    is_int "$v" && v="$(perl -e 'printf "%.1f", $ARGV[0] / 1073741824' "$v" 2>/dev/null)"
  fi
  is_num "$v" && num_gt "$v" 0 && printf '%s' "$v"
}
probe_load1() {
  local v
  override HEAVY_GUARD_LOAD1 && return 0
  if [ -r "$PROCFS/loadavg" ]; then
    v="$(cut -d' ' -f1 "$PROCFS/loadavg" 2>/dev/null)"
  else
    v="$(bounded sysctl -n vm.loadavg | tr -d '{}' 2>/dev/null | awk '{ print $1 }' 2>/dev/null)"
  fi
  if ! is_num "$v"; then # uptime: "load average: 0.52, 0.58, 0.59" (Linux) or "load averages: 3.33 2.85 3.27" (macOS)
    v="$(bounded env LC_ALL=C uptime | sed -n 's/.*load average[s]*: *//p' 2>/dev/null | tr ',' ' ' 2>/dev/null | awk '{ print $1 }' 2>/dev/null)"
  fi
  is_num "$v" && printf '%s' "$v"
}
probe_cores() {
  local v
  override HEAVY_GUARD_CORES && return 0
  v="$(bounded sysctl -n hw.ncpu)"
  is_int "$v" || v="$(bounded nproc)"
  is_int "$v" || v="$(bounded getconf _NPROCESSORS_ONLN)"
  is_int "$v" && [ "$v" -gt 0 ] && printf '%s' "$v"
}
probe_now() {
  local v
  if overridden HEAVY_GUARD_NOW; then v="$HEAVY_GUARD_NOW"
  elif overridden HEAVY_GUARD_NOW_FILE; then v="$(sed -n 1p "$HEAVY_GUARD_NOW_FILE" 2>/dev/null)"
  else v="$(bounded date +%s)"; fi
  is_int "$v" && printf '%s' "$v"
}
probe_swap() { # status only: "1.2 GB used", or nothing
  local u t f
  if [ -r "$PROCFS/meminfo" ]; then
    t="$(sed -n 's/^SwapTotal: *\([0-9]*\) kB.*/\1/p' "$PROCFS/meminfo" 2>/dev/null)"
    f="$(sed -n 's/^SwapFree: *\([0-9]*\) kB.*/\1/p' "$PROCFS/meminfo" 2>/dev/null)"
    is_int "$t" && is_int "$f" && perl -e 'printf "%.1f GB used of %.1f GB", ($ARGV[0] - $ARGV[1]) / 1048576, $ARGV[0] / 1048576' "$t" "$f" 2>/dev/null
  else
    u="$(bounded sysctl -n vm.swapusage | sed -n 's/.*used = *\([0-9.]*[KMG]\).*/\1/p' 2>/dev/null)"
    [ -n "$u" ] && printf '%s used' "$u"
  fi
}

# ---- the heavy lock --------------------------------------------------------------------------------------------------------
alive() { # alive <pid>: 0 alive, 1 gone, 2 cannot tell. It looks, never signals: /proc on Linux, ps -p elsewhere
  is_int "$1" || return 1
  if [ -d /proc/self ]; then [ -d "/proc/$1" ] && return 0; return 1; fi
  bounded env LC_ALL=C ps -p "$1" -o pid= > /dev/null && return 0
  bounded env LC_ALL=C ps -p "$$" -o pid= > /dev/null && return 1 # ps works (it sees this shell), so that pid is gone
  return 2
}
lock_holder() { # the pid holding the heavy lock, if it is alive (or cannot be told from alive); nothing otherwise
  local p
  p="$(sed -n 1p "$LOCK_DIR/owner" 2>/dev/null)"
  is_int "$p" || return 0
  alive "$p"
  [ $? = 1 ] || printf '%s' "$p"
}
# lock_settling: 0 when the heavy lock changed hands less than SETTLE seconds ago. A take and a release (ci_lock_release
# renames mutex-suites away, then removes it) both change the locks folder, so its mtime is at or after the last release; any
# other lock in that folder changing too only makes the guard more lenient. A clock or folder it cannot read: settling (go).
lock_settling() {
  local m now
  [ -d "$LOCKS" ] || return 1
  m="$(mtime "$LOCKS")" now="$(probe_now)"
  is_int "$m" && is_int "$now" || return 0
  [ $((now - m)) -lt "$SETTLE" ]
}

# ---- bookings --------------------------------------------------------------------------------------------------------------
# bookings.tsv: from-epoch <TAB> to-epoch <TAB> who <TAB> note. A row is well formed when `book` could have written it:
# exactly four fields, an end after its start, at most 12 hours long, a who of 1-40 characters and a note of at most 120, with
# no control characters. Every write keeps each well-formed row that has not ended and drops the rest (a clock that stepped
# back never costs anyone a booking), and stamps the file with the time of the write. The READER also asks that a row start
# at most 48 hours after that stamp, and honours at most the first 20 such rows; a stamp it cannot read, or one more than a
# minute in the future, is no bookings. So whatever a file holds, hand-edited or damaged, it stops refusing at most 60 hours
# after it was last written. A file that is missing, unreadable, not a regular file or garbage is no bookings. Only the
# first 10,000 lines are looked at.
# shellcheck disable=SC2016
ROW_OK='
  use strict;
  sub row_ok { my ($l, $now) = @_;
    return undef if length($l) > 4096;
    $l =~ s/\r?\n\z//;
    my @x = split /\t/, $l, -1; return undef unless @x == 4;
    my ($f, $t, $w, $n) = @x;
    return undef unless $f =~ /^\d{1,12}$/ && $t =~ /^\d{1,12}$/ && $t > $f && $t - $f <= 12 * 3600;
    return undef if $t <= $now;
    utf8::decode($w); utf8::decode($n);
    return undef unless length($w) && length($w) <= 40 && length($n) <= 120 && "$w$n" !~ /[\x00-\x1f\x7f-\x9f]/;
    return [$f, $t, $w, $n] }
  # rows <file> <now> <reader>: the well-formed rows not ended, oldest first; for the reader, only those that start at most
  # 48 hours after the file was written, the first 20 of them, and none at all when that time is unreadable or ahead of now
  sub rows { my ($file, $now, $reader) = @_; my @rows; my $by;
    return () unless defined $file && -f $file && -r _ && open(my $fh, "<", $file);
    if ($reader) { my @s = stat $fh; return () unless @s && $s[9] =~ /^\d+$/ && $s[9] <= $now + 60; $by = $s[9] + 48 * 3600 }
    my $n = 0;
    while (defined(my $l = <$fh>)) {
      last if ++$n > 10000;
      my $r = row_ok($l, $now) or next;
      next if defined $by && $r->[0] > $by;
      push @rows, $r;
      last if $reader && @rows >= 20 }
    return sort { $a->[0] <=> $b->[0] } @rows }
'
# shellcheck disable=SC2016
BK_READ='
  my ($file, $now) = @ARGV; binmode STDOUT, ":encoding(UTF-8)";
  print join("\t", @$_), "\n" for rows($file, $now, 1);
'
bookings_read() { perl -e "$ROW_OK$BK_READ" "$BOOKINGS" "$1" 2>/dev/null; } # bookings_read <now>: live bookings, oldest first
when() { # when <epoch> <now>: HH:MM today, else YYYY-MM-DD HH:MM
  perl -MPOSIX=strftime -e 'my @a = localtime $ARGV[0]; my @b = localtime $ARGV[1];
    print strftime(($a[3] == $b[3] && $a[4] == $b[4] && $a[5] == $b[5]) ? "%H:%M" : "%Y-%m-%d %H:%M", @a)' "$1" "$2" 2>/dev/null
}

# ---- the verdict -----------------------------------------------------------------------------------------------------------
NOT_NOW="" WHY="" GO_LINE="go"
# booking_check <exempt who> <now>: the first live booking that covers now, by someone other than <exempt who>
booking_check() {
  local me="$1" now="$2" f t w note
  [ -n "$BOOK_ON" ] || return 0
  is_int "$now" || return 0
  while IFS="$(printf '\t')" read -r f t w note; do
    [ -n "$me" ] && [ "$w" = "$me" ] && continue
    if num_le "$f" "$now" && num_lt "$now" "$t"; then
      NOT_NOW="not now: booked for $w until $(when "$t" "$now")${note:+ ($note)}"
      WHY="booked for $w until $(when "$t" "$now")"
      return 0
    fi
  done <<EOF
$(bookings_read "$now")
EOF
}
memory_check() { # memory_check [gb]: free memory (after taking gb) below the floor
  local free total after
  [ -n "$FLOOR" ] || return 0
  free="$(probe_free_pct)"
  is_num "$free" || return 0
  if [ -n "${1:-}" ]; then
    total="$(probe_mem_gb)"
    is_num "$total" && num_gt "$total" 0 || return 0
    after="$(perl -e 'printf "%.4f", $ARGV[0] - $ARGV[1] / $ARGV[2] * 100' "$free" "$1" "$total" 2>/dev/null)"
    case "$after" in -*) after=0 ;; esac
    if num_lt "$after" "$FLOOR"; then
      NOT_NOW="not now: memory is tight ($(fmt "$after")% free after $(fmt "$1") GB, needs $(fmt "$FLOOR")%)"
      WHY="memory $(fmt "$after")% free after $(fmt "$1") GB, floor $(fmt "$FLOOR")%"
    fi
  elif num_lt "$free" "$FLOOR"; then
    NOT_NOW="not now: memory is tight ($(fmt "$free")% free, needs $(fmt "$FLOOR")%)"
    WHY="memory $(fmt "$free")% free, floor $(fmt "$FLOOR")%"
  fi
}
# load_check <job|ask>: the 1-minute load above the limit. The lock's own work is never refused for the load it causes: for a
# job (the hook), the load check is skipped while the heavy lock is held by a living holder (which covers a job that runs
# inside that holder, `heavy-lock.sh held`) and for SETTLE seconds after the lock last changed hands, because one CI run takes
# it several times in a row and the load between two of its holds is still its own. So it only answers "may a new job START
# on a lock that has been idle a while". `ask` is not the lock's work, so it always gets the load check. The memory floor
# applies either way. A load limit is meant for machines that are not CI runners.
load_check() {
  local load cores
  [ -n "$LIMIT" ] || return 0
  load="$(probe_load1)"
  is_num "$load" || return 0
  num_gt "$load" "$LIMIT" || return 0
  if [ "$1" = job ]; then
    [ -n "$(lock_holder)" ] && return 0
    lock_settling && return 0
  fi
  cores="$(probe_cores)"
  if num_gt "$load" "$LIMIT"; then
    NOT_NOW="not now: load is $load${cores:+ on $cores cores} (limit $(fmt "$LIMIT"))"
    WHY="load $load, limit $(fmt "$LIMIT")"
  fi
}
record_refusal() { # one line, atomically; a failure here never changes the exit code
  local t ts
  ts="$(probe_now)"
  is_int "$ts" || ts="$(epoch)" # the probe may have run out of time; the record still gets one
  mkdir -p "$GDIR" 2>/dev/null || return 0
  t="$(mktemp "$GDIR/.last.XXXXXX" 2>/dev/null)" || return 0
  if printf '%s\t%s\n' "$ts" "$(clean "$WHY, $1" 200)" > "$t" 2>/dev/null && chmod 600 "$t" 2>/dev/null &&
    mv -f "$t" "$LAST" 2>/dev/null; then return 0; fi
  rm -f "$t" 2>/dev/null
  return 0
}
finish() { # finish <who for the record>: THE one place that exits 75, and only when a check set NOT_NOW
  if [ -n "$NOT_NOW" ]; then
    printf '%s\n' "$NOT_NOW"
    record_refusal "$1"
    exit 75
  fi
  printf '%s\n' "$GO_LINE"
  exit 0
}
hook_deadline() { # the hook answers within about 5 s whatever its probes do: 3 s each, none past 5 s from now
  local s
  s="$(epoch)"
  is_int "$s" && DEADLINE=$((s + 5))
  PROBE_S=3
}

cmd_check() {
  local job now
  job="$(clean "$1" 80)" # a name is data: control characters out and 80 characters at most, before any compare or record
  read_settings
  if [ "$S_OFF" = 1 ]; then printf 'guard off\n'; exit 0; fi
  if [ -z "$CONFIGURED" ]; then printf 'go: guard off on this machine (no guard.env)\n'; exit 0; fi
  hook_deadline
  now="$(probe_now)"
  booking_check "$job" "$now"
  [ -n "$NOT_NOW" ] || memory_check
  [ -n "$NOT_NOW" ] || load_check job
  finish "job $job"
}

cmd_ask() {
  local gb="${1:-}" who now
  who="$(clean "${2:-}" 80)" # data, as a job name is
  is_num "$gb" && num_gt "$gb" 0 || bad_usage
  [ $# -le 2 ] || bad_usage
  read_settings
  if [ "$S_OFF" = 1 ]; then printf 'guard off\n'; exit 0; fi
  if [ -z "$CONFIGURED" ]; then printf 'guard off: nobody is checking\n'; exit 0; fi
  hook_deadline
  now="$(probe_now)"
  booking_check "$who" "$now"
  [ -n "$NOT_NOW" ] || memory_check "$gb"
  [ -n "$NOT_NOW" ] || load_check ask
  finish "ask ${gb} GB${who:+ for $(clean "$who" 40)}"
}

# ---- writes: bookings and settings -----------------------------------------------------------------------------------------
refuse() { printf "%s\n" "$1" >&2; exit 65; }
wdir() { mkdir -p -m 700 "$GDIR" 2>/dev/null || refuse "refused: cannot create $GDIR"; }

# book/unbook, in perl, holding an flock on bookings.tsv.flock so two writers never interleave (the kernel lets go of it when
# its holder exits, however it exits, so a writer that died or a reused pid never blocks the next): validate, read (only rows
# `book` could have written), change, write a temp file and rename it into place. Exit 0 done, 65 refused (the message is on
# stderr), 64 usage.
# shellcheck disable=SC2016
BK_WRITE='
  use POSIX qw(mktime strftime);
  my ($op, $file, $now, $who, $from, $to, $note) = @ARGV;
  binmode STDOUT, ":encoding(UTF-8)"; binmode STDERR, ":encoding(UTF-8)";
  utf8::decode($_) for grep { defined } ($who, $note);
  sub refuse_ { print STDERR "$_[0]\n"; exit 65 }
  use Fcntl qw(:flock);
  open(my $lk, ">>", "$file.flock") or refuse_("refused: cannot open the bookings lock file $file.flock ($!); unbook --all --yes clears it");
  chmod 0600, "$file.flock";
  my $why = "";
  my $got = eval { local $SIG{ALRM} = sub { die "late\n" }; alarm 20; flock($lk, LOCK_EX) or do { $why = "$!"; die "no\n" }; alarm 0; 1 };
  unless ($got) {
    refuse_("refused: another writer has held the bookings file for 20 s; try again") if $@ eq "late\n";
    refuse_("refused: cannot lock the bookings file ($why)") }
  sub tm { my ($s) = @_; my ($y, $mo, $d, $h, $mi);
    if ($s =~ /^(\d{1,2}):(\d\d)$/) { my @l = localtime $now; ($y, $mo, $d, $h, $mi) = ($l[5] + 1900, $l[4] + 1, $l[3], $1, $2) }
    elsif ($s =~ /^(\d{4})-(\d\d)-(\d\d)T(\d{1,2}):(\d\d)$/) { ($y, $mo, $d, $h, $mi) = ($1, $2, $3, $4, $5) }
    else { return undef }
    return undef if $h > 23 || $mi > 59 || $mo < 1 || $mo > 12 || $d < 1 || $d > 31 || $y < 1971 || $y > 2999;
    my $t = mktime(0, $mi, $h, $d, $mo - 1, $y - 1900, 0, 0, -1); return undef unless defined $t;
    my @b = localtime $t; return undef unless $b[3] == $d && $b[4] == $mo - 1; $t }
  sub show { my ($t) = @_; my @a = localtime $t; my @b = localtime $now;
    strftime(($a[3] == $b[3] && $a[4] == $b[4] && $a[5] == $b[5]) ? "%H:%M" : "%Y-%m-%d %H:%M", @a) }
  refuse_("refused: a name is needed") unless defined $who && length $who;
  refuse_("refused: the name has a control character") if $who =~ /[\x00-\x1f\x7f-\x9f]/;
  refuse_("refused: the name is longer than 40 characters") if length($who) > 40;
  my @rows = rows($file, $now, 0); # every well-formed row not ended: a write never drops a booking the reader may want later
  my $msg;
  if ($op eq "book") {
    $note = "" unless defined $note;
    refuse_("refused: the note has a control character") if $note =~ /[\x00-\x1f\x7f-\x9f]/;
    refuse_("refused: the note is longer than 120 characters") if length($note) > 120;
    my $f = tm($from); my $t = tm($to);
    exit 64 unless defined $f && defined $t;
    refuse_("refused: the window ends before it starts") if $t <= $f;
    refuse_("refused: a window may be 12 hours at most") if $t - $f > 12 * 3600;
    refuse_("refused: that window has already ended") if $t <= $now;
    refuse_("refused: a window may start at most 48 hours from now") if $f > $now + 48 * 3600;
    my $mine = $t - $f; $mine += $_->[1] - $_->[0] for grep { $_->[2] eq $who } @rows;
    refuse_("refused: $who would have more than 12 hours booked") if $mine > 12 * 3600;
    refuse_("refused: there are 20 bookings already") if @rows >= 20;
    for my $r (@rows) { next if $r->[2] eq $who;
      refuse_("refused: that window overlaps a booking by $r->[2] from " . show($r->[0]) . " to " . show($r->[1]))
        if $f < $r->[1] && $r->[0] < $t }
    push @rows, [$f, $t, $who, $note];
    $msg = "booked for $who from " . show($f) . " to " . show($t) . (length $note ? " ($note)" : "");
  } else {
    my $f; if (defined $from) { $f = tm($from); exit 64 unless defined $f }
    my $before = @rows;
    @rows = grep { !($_->[2] eq $who && (!defined $f || $_->[0] == $f)) } @rows;
    my $gone = $before - @rows;
    $msg = $gone ? "removed $gone booking" . ($gone == 1 ? "" : "s") . " for $who" : "no bookings for $who" . (defined $f ? " starting at " . show($f) : "");
  }
  my $tmp = "$file.tmp.$$";
  umask 077;
  open(my $out, ">:encoding(UTF-8)", $tmp) or refuse_("refused: cannot write the bookings file");
  print $out join("\t", @$_), "\n" for sort { $a->[0] <=> $b->[0] } @rows;
  close($out) or do { unlink $tmp; refuse_("refused: cannot write the bookings file") };
  chmod 0600, $tmp;
  # the stamp the reader measures "48 hours ahead" from: the guard clock at this write, never moved back by a clock that
  # stepped back (up to 48 hours: a stamp further ahead than that is not trusted, and this write replaces it)
  my @old = stat $file; my $stamp = $now;
  $stamp = $old[9] if @old && $old[9] > $now && $old[9] <= $now + 48 * 3600;
  utime($stamp, $stamp, $tmp);
  rename($tmp, $file) or do { unlink $tmp; refuse_("refused: cannot write the bookings file") };
  print "$msg\n";
'
cmd_book() {
  local who="${1:-}" from="${2:-}" to="${3:-}" note now rc
  [ $# -ge 3 ] || bad_usage
  shift 3
  note="$*"
  read_settings
  [ -n "$BOOK_ON" ] || refuse "refused: bookings are off on this machine; turn them on with: scripts/heavy-guard.sh init --bookings (with any other settings you want kept)"
  now="$(probe_now)"
  is_int "$now" || refuse "refused: cannot read the clock"
  wdir
  perl -e "$ROW_OK$BK_WRITE" book "$BOOKINGS" "$now" "$who" "$from" "$to" "$note"
  rc=$?
  case "$rc" in 0) exit 0 ;; 64) bad_usage ;; 65) exit 65 ;; *) refuse "refused: the booking was not written (perl exit $rc)" ;; esac
}
cmd_unbook() {
  local who="${1:-}" now rc
  [ $# -ge 1 ] && [ $# -le 2 ] && [ -n "$who" ] || bad_usage
  if [ "$who" = --all ]; then # the escape that always works: no lock taken, nothing opened; the file and its lock just go
    [ "${2:-}" = --yes ] || bad_usage
    local gone="" f
    for f in "$BOOKINGS" "$BOOKINGS.flock"; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      rm -rf "$f" 2>/dev/null
      if [ -e "$f" ] || [ -L "$f" ]; then refuse "refused: cannot remove $f"; fi
      gone="$gone${gone:+, }$(basename "$f")"
    done
    echo "removed every booking${gone:+ ($gone)}"
    exit 0
  fi
  now="$(probe_now)"
  is_int "$now" || refuse "refused: cannot read the clock"
  wdir
  if [ $# = 2 ]; then perl -e "$ROW_OK$BK_WRITE" unbook "$BOOKINGS" "$now" "$who" "$2"; else perl -e "$ROW_OK$BK_WRITE" unbook "$BOOKINGS" "$now" "$who"; fi
  rc=$?
  case "$rc" in 0) exit 0 ;; 64) bad_usage ;; 65) exit 65 ;; *) refuse "refused: nothing was changed (perl exit $rc)" ;; esac
}

cmd_init() {
  local min="" load="" book="" t
  while [ $# -gt 0 ]; do
    case "$1" in
      --min-free-pct) [ $# -ge 2 ] && is_num "$2" && num_gt "$2" 0 && num_le "$2" 100 || bad_usage; min="$2"; shift 2 ;;
      --max-load) [ $# -ge 2 ] && is_num "$2" && num_gt "$2" 0 || bad_usage; load="$2"; shift 2 ;;
      --bookings) book=1; shift ;;
      *) bad_usage ;;
    esac
  done
  [ -n "$min$load$book" ] || bad_usage
  mkdir -p -m 700 "$GDIR" 2>/dev/null || refuse "refused: cannot create $GDIR"
  t="$(mktemp "$GDIR/.guard.env.XXXXXX" 2>/dev/null)" || refuse "refused: cannot write $GENV"
  {
    echo "# heavy-guard settings for this machine, written by scripts/heavy-guard.sh init. KEY=value lines only."
    [ -z "$min" ] || echo "HEAVY_GUARD_MIN_FREE_PCT=$min"
    [ -z "$load" ] || echo "HEAVY_GUARD_MAX_LOAD=$load"
    [ -z "$book" ] || echo "HEAVY_GUARD_BOOKINGS=1"
  } > "$t" 2>/dev/null && chmod 600 "$t" 2>/dev/null && mv -f "$t" "$GENV" 2>/dev/null ||
    { rm -f "$t" 2>/dev/null; refuse "refused: cannot write $GENV"; }
  echo "guard on: memory floor $(either "$min" "$min%" off), load limit ${load:-off}, bookings $(either "$book" on off) ($GENV)"
}
cmd_off() { # off --yes (the word alone is a job name: see the dispatch at the end)
  [ $# = 1 ] && [ "$1" = --yes ] || bad_usage
  if [ -e "$GENV" ]; then
    rm -f "$GENV" 2>/dev/null || refuse "refused: cannot remove $GENV"
    echo "guard off: removed $GENV"
  else
    echo "guard off: there was no guard.env"
  fi
}

# ---- status ----------------------------------------------------------------------------------------------------------------
# Possible strays, in perl: from `ps`, the processes whose command holds a pattern, older than the minutes given, and NOT the
# heavy lock's holder, a process under it, a process in a group recorded for it, this guard and its children, or a tmux whose
# -L (socket name) is exactly `talos`, wherever the flag sits (`-L talos`, `-Ltalos`, `-uL talos`, after other flags).
# shellcheck disable=SC2016
STRAYS='
  use strict; my ($min, $holder, $groups, $self) = @ARGV;
  my @pat = grep { length } split /\n/, $ENV{HG_PATTERNS} // "";
  my %g = map { $_ => 1 } grep { /^\d+$/ } split /\s+/, $groups // "";
  my (%kids, @p);
  while (my $l = <STDIN>) {
    my ($pid, $pg, $pp, $et, $cpu, $rss, $cmd) = $l =~ /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/ or next;
    push @{$kids{$pp}}, $pid; push @p, [$pid, $pg, $et, $cpu, $rss, $cmd];
  }
  my %skip; my @todo = grep { /^\d+$/ && $_ > 0 } ($holder, $self);
  push @todo, map { $_->[0] } grep { $g{$_->[1]} } @p;
  while (defined(my $x = shift @todo)) { next if $skip{$x}++; push @todo, @{$kids{$x} || []} }
  my $n = 0;
  for my $r (@p) {
    my ($pid, $pg, $et, $cpu, $rss, $cmd) = @$r;
    next if $skip{$pid} || $g{$pg};
    my @w = split /\s+/, $cmd;
    if (@w && $w[0] =~ m{(^|/)tmux$}) { # the live agent server, never
      my $live = 0;
      for my $i (1 .. $#w) {
        if ($w[$i] =~ /^-[A-Za-z]*L(.*)$/) { my $v = length $1 ? $1 : ($w[$i + 1] // ""); $live = 1 if $v eq "talos" }
      }
      next if $live;
    }
    next unless grep { index($cmd, $_) >= 0 } @pat;
    my ($d, $h, $m, $s) = $et =~ /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/ or next;
    my $age = ((($d // 0) * 24 + ($h // 0)) * 60 + $m) * 60 + $s;
    next if $age < $min * 60;
    my $c = $cmd; $c =~ s/[\x00-\x1f\x7f]/ /g;
    printf "  pid %d, running %dh%02dm, %s%% CPU, %d MB: %s\n", $pid, int($age / 3600), int($age % 3600 / 60), $cpu, $rss / 1024, substr($c, 0, 100);
    $n++;
  }
  print "  none\n" unless $n;
'
cmd_status() {
  local free total load cores swap now holder groups r f t w note any="" table m
  PROBE_S=5 DEADLINE="$(epoch)" # 5 s a probe, and all of them within 15 s
  is_int "$DEADLINE" && DEADLINE=$((DEADLINE + 15))
  read_settings
  testing && echo "warning: HEAVY_GUARD_TEST=1: readings marked (test override) come from variables, not this machine"
  if [ "$S_OFF" = 1 ]; then echo "guard: off (HEAVY_GUARD_OFF=1)"
  elif [ -z "$CONFIGURED" ]; then echo "guard: off on this machine (no guard.env)"
  else echo "guard: on, from $WHERE"; fi
  now="$(probe_now)"
  free="$(probe_free_pct)" total="$(probe_mem_gb)"
  printf 'memory: %s free%s%s, floor %s\n' "$(either "$free" "$(fmt "$free")%" unknown)" "$(mark HEAVY_GUARD_FREE_PCT)" \
    "${total:+ of $(fmt "$total") GB$(mark HEAVY_GUARD_MEM_GB)}" "$(either "$FLOOR" "$(fmt "$FLOOR")%" off)"
  [ -z "$S_MIN" ] || [ -n "$FLOOR" ] || echo "  (HEAVY_GUARD_MIN_FREE_PCT=$(clean "$S_MIN" 20) is not a percentage from 1 to 100: the floor is off)"
  swap="$(probe_swap)"
  [ -z "$swap" ] || echo "swap: $swap"
  load="$(probe_load1)" cores="$(probe_cores)"
  printf 'load: %s (1 min)%s on %s cores%s, limit %s\n' "${load:-unknown}" "$(mark HEAVY_GUARD_LOAD1)" "${cores:-unknown}" \
    "$(mark HEAVY_GUARD_CORES)" "$(either "$LIMIT" "$(fmt "$LIMIT")" off)"
  [ -z "$S_LOAD" ] || [ -n "$LIMIT" ] || echo "  (HEAVY_GUARD_MAX_LOAD=$(clean "$S_LOAD" 20) is not a number above 0: the limit is off)"
  if [ -n "$LIMIT" ]; then # whether a job asking now would get the load check, and why not
    holder="$(lock_holder)" m="$(mtime "$LOCKS")"
    if [ -n "$holder" ]; then
      echo "load limit $(fmt "$LIMIT"): skipped, the heavy lock is held by pid $holder (its load is its own)"
    elif [ -d "$LOCKS" ] && lock_settling; then
      if is_int "$m" && is_int "$now"; then
        echo "load limit $(fmt "$LIMIT"): skipped, the lock changed hands $((now - m)) s ago (settles for $SETTLE s)"
      else
        echo "load limit $(fmt "$LIMIT"): skipped, cannot tell when the lock last changed hands"
      fi
    else
      echo "load limit $(fmt "$LIMIT"): live"
    fi
    echo "  (a load limit is for machines that are not CI runners: a CI run's own load would hold its next step back)"
  fi
  if [ -z "$BOOK_ON" ]; then
    echo "bookings: off"
  elif ! is_int "$now"; then
    echo "bookings: unknown (cannot read the clock)"
  else
    echo "bookings:$(mark HEAVY_GUARD_NOW)$(mark HEAVY_GUARD_NOW_FILE)"
    while IFS="$(printf '\t')" read -r f t w note; do
      [ -n "$w" ] || continue
      any=1
      if num_le "$f" "$now"; then printf '  now: %s until %s' "$w" "$(when "$t" "$now")"
      else printf '  next: %s from %s to %s' "$w" "$(when "$f" "$now")" "$(when "$t" "$now")"; fi
      [ -z "$note" ] || printf ' (%s)' "$note"
      echo
    done <<EOF
$(bookings_read "$now")
EOF
    [ -n "$any" ] || echo "  none"
  fi
  r="$(bounded env TALOS_CI_CACHE="$CACHE" bash "$HERE/heavy-lock.sh" status)"
  if [ -n "$r" ]; then printf '%s\n' "$r"; else echo "heavy lock: unknown"; fi
  r="$(sed -n 1p "$LAST" 2>/dev/null)"
  if [ -n "$r" ] && is_int "${r%%	*}"; then
    echo "last refusal: $(when "${r%%	*}" "${now:-0}"), $(clean "${r#*	}" 200)"
  elif [ -f "$GENV" ]; then
    echo "last refusal: none since $(perl -MPOSIX=strftime -e 'my @s = stat $ARGV[0]; print @s ? strftime("%Y-%m-%d %H:%M", localtime $s[9]) : "?"' "$GENV" 2>/dev/null)"
  else
    echo "last refusal: none"
  fi
  holder="$(lock_holder)" groups=""
  if [ -n "$holder" ]; then
    for r in "$CACHE/runs"/*; do
      [ "$(sed -n 1p "$r/owner" 2>/dev/null)" = "$holder" ] || continue
      groups="$groups $(cut -d' ' -f1 "$r/groups" 2>/dev/null | tr '\n' ' ')"
    done
  fi
  echo "possible strays (heavy-looking, over $STRAY_MIN min, not the heavy lock's holder; the first 100 characters of each command):"
  table="$(bounded env LC_ALL=C ps -A -ww -o pid= -o pgid= -o ppid= -o etime= -o pcpu= -o rss= -o args=)"
  if [ -n "$table" ]; then
    printf '%s\n' "$table" | HG_PATTERNS="$STRAY_PATTERNS" perl -e "$STRAYS" "$STRAY_MIN" "${holder:-0}" "$groups" "$$" 2>/dev/null ||
      echo "  unknown"
  else
    echo "  unknown"
  fi
  echo "This guard lists and refuses. It never stops a process: the owner of a job stops it, by pid."
  exit 0
}

# ONE argument is always the hook form, a job check for that name, whatever the word: heavy-lock.sh passes any name a caller
# gave `run <name>`, so a job called "off" or "init" must never act as a command. Only status, --help and -h are not.
if [ $# = 1 ]; then
  case "$1" in
    -h | --help) usage; exit 0 ;;
    status) loud; cmd_status ;;
    *) loud; cmd_check "$1" ;;
  esac
fi
case "${1:-}" in
  check) [ $# = 2 ] || bad_usage; loud; cmd_check "$2" ;;
  ask) shift; loud; cmd_ask "$@" ;;
  book) shift; cmd_book "$@" ;;
  unbook) shift; cmd_unbook "$@" ;;
  init) shift; cmd_init "$@" ;;
  off) shift; cmd_off "$@" ;;
  *) bad_usage ;;
esac
