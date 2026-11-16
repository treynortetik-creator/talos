#!/usr/bin/env bash
# Watches the remote for personal data that reached it from a machine without the private list (docs/CI-LOCAL.md,
# "The personal-data watch"). Every interval it fetches branches and tags into a cache clone of its own and runs
# scripts/check-ref-personal.sh on:
#   - every new commit on main, by first parent, since the last one it saw (a merge brings in every commit it merged);
#   - every branch other than main (handoff/* included) and every tag that is new or has moved, against the old tip when that is
#     an ancestor, else against the merge-base with main. An annotated tag's message is checked too.
# Every ref's own name is checked as text. It never touches a checkout or worktree: the cache is a bare clone in <home>/repo.
#
#   scripts/personal-watch.sh --rules <path to the main checkout's scripts/personal-denylist.txt> [options]
#     --rules PATH      the private list (or PERSONAL_WATCH_RULES). Read where it is, never copied. Required.
#     --remote URL      what to watch (or PERSONAL_WATCH_REMOTE; default: origin of the checkout this script is in)
#     --home DIR        cache, state and log (or PERSONAL_WATCH_HOME; default ~/.cache/talos-personal-watch)
#     --interval N      seconds between fetches (or PERSONAL_WATCH_INTERVAL; default 120)
#     --once            one pass, then exit (0 clean, 1 a new hit, 2 an error or a commit still unchecked)
#     --scan-existing   on the first pass, check the branches and tags already there too (default: record them as seen)
#     --scan-main       check every file and path of the current main tree once, print the hits and a count, and exit
#                       (0: main has 0 hits, 1 hits, 2 an error). While a watch holds the cache it reads main as last fetched.
# Timeouts: PERSONAL_WATCH_FETCH_TIMEOUT (120 s), PERSONAL_WATCH_CLONE_TIMEOUT (1800 s), PERSONAL_WATCH_CHECK_TIMEOUT (1800 s); a
# step that runs over is killed with its whole process group. PERSONAL_WATCH_ERROR_EVERY (600 s): an error that persists is
# printed again at most this often, but always again. PERSONAL_WATCH_LOCK_STALE_MIN (10): see the lock below.
#
# Output (stdout, one line per event, each written whole): "personal-watch: HIT <kind>@<sha12> <sha12> <path>:<line> [<rule>]",
# "personal-watch: NOTE ...", "personal-watch: ERROR ...", and a few status lines. <kind> is main, branch or tag, and the sha is
# the ref's: no ref name is ever printed or stored (state files key refs by a hash of the name). Each hit is appended to
# <home>/hits.log as "<UTC time> <kind>@<sha12> <sha12> <path>:<line> [<rule>]". The matched text is never printed or written,
# nor is git's own error text (it can carry the remote's address or a ref name: it stays in <home>/fetch.err and clone.err).
# A hit is reported once per (ref, commit, path, line). A main commit whose check fails is kept on an unchecked list and tried
# again every pass, while the watch moves on to later commits.
# SIGTERM or SIGINT: stops the running step (its whole process group) and exits 0.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_PREFIX
export GIT_TERMINAL_PROMPT=0
umask 077 # the cache, its state and git's own error text are for the owner only

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES="${PERSONAL_WATCH_RULES:-}"
REMOTE="${PERSONAL_WATCH_REMOTE:-}"
WHOME="${PERSONAL_WATCH_HOME:-$HOME/.cache/talos-personal-watch}"
INTERVAL="${PERSONAL_WATCH_INTERVAL:-120}"
FETCH_TIMEOUT="${PERSONAL_WATCH_FETCH_TIMEOUT:-120}"
CLONE_TIMEOUT="${PERSONAL_WATCH_CLONE_TIMEOUT:-1800}"
CHECK_TIMEOUT="${PERSONAL_WATCH_CHECK_TIMEOUT:-1800}"
ERROR_EVERY="${PERSONAL_WATCH_ERROR_EVERY:-600}"
STALE_MIN="${PERSONAL_WATCH_LOCK_STALE_MIN:-10}"
ONCE=0 SCAN_EXISTING=0 SCAN_MAIN=0
say() { printf 'personal-watch: %s\n' "$*"; }
fatal() { say "ERROR $*"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --rules) RULES="${2:-}"; shift 2 || fatal "--rules needs a path" ;;
    --remote) REMOTE="${2:-}"; shift 2 || fatal "--remote needs a URL" ;;
    --home) WHOME="${2:-}"; shift 2 || fatal "--home needs a folder" ;;
    --interval) INTERVAL="${2:-}"; shift 2 || fatal "--interval needs seconds" ;;
    --once) ONCE=1; shift ;;
    --scan-existing) SCAN_EXISTING=1; shift ;;
    --scan-main) SCAN_MAIN=1; shift ;;
    *) fatal "unknown argument (see the top of scripts/personal-watch.sh)" ;;
  esac
done
for n in "$INTERVAL" "$FETCH_TIMEOUT" "$CLONE_TIMEOUT" "$CHECK_TIMEOUT" "$STALE_MIN"; do
  case "$n" in '' | *[!0-9]* | 0) fatal "intervals, timeouts and the lock age must be whole numbers above 0" ;; esac
done
case "$ERROR_EVERY" in '' | *[!0-9]*) fatal "PERSONAL_WATCH_ERROR_EVERY must be a whole number of seconds" ;; esac
command -v perl >/dev/null || fatal "perl is needed"
# Without the private list this watch adds nothing over the gate on the other machines: refuse rather than look clean.
[ -n "$RULES" ] || fatal "no private list: give --rules <main checkout>/scripts/personal-denylist.txt"
[ -f "$RULES" ] || fatal "the private list named in --rules does not exist"
RULES="$(cd "$(dirname "$RULES")" && pwd)/$(basename "$RULES")"
if [ -z "$REMOTE" ]; then REMOTE="$(git -C "$HERE" remote get-url origin 2>/dev/null)" || fatal "no --remote and no origin to default to"; fi

mkdir -p "$WHOME" || fatal "could not make the cache folder"
REPO="$WHOME/repo" SEEN="$WHOME/seen" REPORTED="$WHOME/reported" LOG="$WHOME/hits.log" LOCK="$WHOME/lock"
UNCHECKED="$WHOME/unchecked" ERRS="$WHOME/errors"
OUT="$WHOME/check.$$.out" CERR="$WHOME/check.$$.err" # per process: a --scan-main may run beside the watch

child=""
stopping=0
HAVE_LOCK=0
killchild() { [ -n "$child" ] || return 0; kill -TERM -- "-$child" 2>/dev/null; kill -TERM "$child" 2>/dev/null; return 0; }
on_signal() { stopping=1; killchild; }
cleanup() {
  killchild
  rm -f "$OUT" "$CERR"
  if [ "$HAVE_LOCK" = 1 ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK"; fi
}
trap on_signal TERM INT
trap cleanup EXIT

# run_timed <seconds> <cmd...>: runs the command in a process group of its own and waits, polling, so a signal is handled within
# a fifth of a second. Past <seconds> the whole group is killed (exit 124). On a signal it is killed too (exit 143).
run_timed() {
  local t="$1" ticks=0 r=0
  shift
  perl -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127' "$@" &
  child=$!
  [ "$stopping" = 1 ] && killchild
  while kill -0 "$child" 2>/dev/null; do
    if [ "$ticks" -ge $((t * 5)) ]; then
      killchild
      sleep 1
      kill -KILL -- "-$child" 2>/dev/null
      kill -KILL "$child" 2>/dev/null
      wait "$child" 2>/dev/null
      child=""
      return 124
    fi
    sleep 0.2
    ticks=$((ticks + 1))
  done
  wait "$child" || r=$?
  child=""
  [ "$stopping" = 1 ] && return 143
  return "$r"
}

# The lock: one watch per cache folder. mkdir is the atomic step; the pid goes in by rename, so it is never half written. A lock
# is stale only when its pid file names a process that is gone, or when it has no pid file and is older than STALE_MIN minutes
# (its taker died between the two steps). A stale lock is first moved aside, so two takers can't both remove it.
LOCK_OWNER=""
take_lock() { # 0 taken, 1 held by a live watch, 2 could not
  local tries=0 other stale judged moved
  while [ "$tries" -lt 5 ]; do
    tries=$((tries + 1))
    if mkdir "$LOCK" 2>/dev/null; then
      if printf '%s\n' "$$" > "$LOCK/pid.$$" && mv "$LOCK/pid.$$" "$LOCK/pid"; then HAVE_LOCK=1; return 0; fi
      rm -rf "$LOCK"
      return 2
    fi
    [ -d "$LOCK" ] || continue
    stale=0 other=""
    if [ -f "$LOCK/pid" ]; then
      other="$(cat "$LOCK/pid" 2>/dev/null)"
      case "$other" in '' | *[!0-9]*) other="" ;; esac
    fi
    if [ -n "$other" ]; then
      if kill -0 "$other" 2>/dev/null; then LOCK_OWNER="pid $other"; return 1; fi
      stale=1
    elif [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+$STALE_MIN" 2>/dev/null)" ]; then
      stale=1
    else
      LOCK_OWNER="a watch that is starting"
      return 1
    fi
    [ "$stale" = 1 ] || continue
    judged="$other"
    # tests only: stands in for another watch acting between the look above and the move below
    [ -n "${PERSONAL_WATCH_TEST_LOCK_GAP:-}" ] && bash "$PERSONAL_WATCH_TEST_LOCK_GAP" "$LOCK"
    mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null || continue
    # What was moved must be the lock judged stale: the same dead pid, or still no pid and still old. Another taker may have
    # removed that one and made a fresh lock in between (no pid yet, or a live one): give that back and stand down.
    moved="$(cat "$LOCK.stale.$$/pid" 2>/dev/null)"
    case "$moved" in '' | *[!0-9]*) moved="" ;; esac
    if [ "$moved" != "$judged" ] || { [ -n "$moved" ] && kill -0 "$moved" 2>/dev/null; } ||
      { [ -z "$moved" ] && [ -z "$(find "$LOCK.stale.$$" -maxdepth 0 -mmin "+$STALE_MIN" 2>/dev/null)" ]; }; then
      # (mv onto a folder that exists would move it inside: only put it back when the place is free)
      if [ -e "$LOCK" ] || ! mv "$LOCK.stale.$$" "$LOCK" 2>/dev/null; then rm -rf "$LOCK.stale.$$"; fi
      LOCK_OWNER="${moved:+pid $moved}"
      LOCK_OWNER="${LOCK_OWNER:-a watch that is starting}"
      return 1
    fi
    rm -rf "$LOCK.stale.$$"
  done
  return 2
}

touch "$ERRS" "$REPORTED" "$WHOME/fetch.err" "$WHOME/clone.err" 2>/dev/null || fatal "could not write in the cache folder"
# git's error text can name the remote: owner-only, also when an older watch made these files
chmod 600 "$WHOME/fetch.err" "$WHOME/clone.err" "$ERRS" "$REPORTED" 2>/dev/null || fatal "could not make the error files private"
# report_error <key> <message>: prints at most once per ERROR_EVERY seconds per key, and again after that, every time
report_error() {
  local key="$1" msg="$2" now last
  now="$(date +%s)"
  last="$(awk -v k="$key" 'substr($0, 1, length(k) + 1) == k " " { v = substr($0, length(k) + 2) } END { print v }' "$ERRS")"
  if [ -z "$last" ] || [ $((now - last)) -ge "$ERROR_EVERY" ]; then
    say "ERROR $msg"
    { awk -v k="$key" 'substr($0, 1, length(k) + 1) != k " "' "$ERRS"; printf '%s %s\n' "$key" "$now"; } > "$ERRS.$$" && mv "$ERRS.$$" "$ERRS"
  fi
}
reported() { grep -qxF -- "$1" "$REPORTED"; }

ensure_clone() {
  local r=0 spec
  if [ ! -d "$REPO" ]; then
    rm -rf "$REPO.tmp"
    say "making the cache clone (once)"
    run_timed "$CLONE_TIMEOUT" git clone --quiet --bare -- "$REMOTE" "$REPO.tmp" < /dev/null > /dev/null 2> "$WHOME/clone.err" || r=$?
    if [ "$r" != 0 ]; then
      rm -rf "$REPO.tmp"
      [ "$stopping" = 1 ] && return 2
      report_error clone "the cache clone failed (exit $r; git's message is in $WHOME/clone.err, not printed); it runs again next pass"
      return 2
    fi
    git -C "$REPO.tmp" config gc.auto 0 && mv "$REPO.tmp" "$REPO" || { report_error clone "could not set up the cache clone"; return 2; }
  fi
  # an older cache may lack the tags refspec
  for spec in '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'; do
    if ! git -C "$REPO" config --get-all remote.origin.fetch 2>/dev/null | grep -qxF -- "$spec"; then
      git -C "$REPO" config --add remote.origin.fetch "$spec" || { report_error clone "could not set up the cache clone"; return 2; }
    fi
  done
}

fetch() {
  local r=0
  ensure_clone || return 2
  run_timed "$FETCH_TIMEOUT" git -C "$REPO" fetch --quiet --prune origin < /dev/null > /dev/null 2> "$WHOME/fetch.err" || r=$?
  [ "$stopping" = 1 ] && return 2
  case "$r" in
    0) return 0 ;;
    124) report_error fetch "the fetch timed out after ${FETCH_TIMEOUT}s and was stopped; nothing new was checked; it runs again next pass" ;;
    *) report_error fetch "the fetch failed (exit $r; git's message is in $WHOME/fetch.err, not printed); nothing new was checked; it runs again next pass" ;;
  esac
  return 2
}

# why_failed: the checker's reason for an exit 2, value-free. Only lines the two scripts write themselves are taken (they start
# with their own name and never hold matched text or a hidden name); git's own error text in the same stream can name a path or a
# ref, so it is never shown. Then the checker's note, when it gave one.
why_failed() {
  local l w="" n=""
  while IFS= read -r l; do case "$l" in 'check-ref-personal: '* | 'check-no-personal: '*) w="$l"; break ;; esac; done < "$CERR"
  while IFS= read -r l; do case "$l" in 'note: '*) n="${l#note: }"; break ;; esac; done < "$OUT"
  printf '%s' "$w${w:+${n:+; }}$n"
}

# check <ref hash> <label> <commit> [<base> [<ref name> [<tag object>]]]: prints new hits and notes; 0 done, 2 the check failed
NEWHIT=0
check() {
  local hash="$1" label="$2" sha="$3" base="${4:-}" name="${5:-}" tagobj="${6:-}" r=0 l s12 rest key at why
  run_timed "$CHECK_TIMEOUT" env CHECK_REPO="$REPO" CHECK_EXTRA_RULES="$RULES" CHECK_REF_NAME="$name" CHECK_TAG_OBJECT="$tagobj" \
    bash "$HERE/check-ref-personal.sh" "$sha" ${base:+"$base"} > "$OUT" 2> "$CERR" < /dev/null || r=$?
  [ "$stopping" = 1 ] && return 2
  case "$r" in
    0 | 1) ;;
    124) report_error "$hash $sha" "the check of $label timed out after ${CHECK_TIMEOUT}s; it runs again next pass"; return 2 ;;
    *)
      why="$(why_failed)"
      report_error "$hash $sha" "the check of $label failed (exit $r${why:+: $why}); it runs again next pass"
      return 2
      ;;
  esac
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  while IFS= read -r l; do
    case "$l" in
      'note: '*)
        rest="${l#note: }" key="$hash note ${l#note: }"
        reported "$key" && continue
        printf '%s\n' "$key" >> "$REPORTED"
        say "NOTE $label $rest"
        ;;
      *)
        s12="${l%% *}" rest="${l#* }"
        key="$hash $s12 ${rest% \[*}"
        reported "$key" && continue
        printf '%s\n' "$key" >> "$REPORTED"
        say "HIT $label $s12 $rest"
        printf '%s %s %s %s\n' "$at" "$label" "$s12" "$rest" >> "$LOG"
        NEWHIT=1
        ;;
    esac
  done < "$OUT"
  return 0
}

# One line per remote ref: "<hash> <kind> <type> <object> <peeled> <peeled type> <last seen> <short name>", "-" for empty. The ref
# name is only ever in memory and in the check's environment; seen is read here ("<hash> <kind> <sha>"; an older watch's
# "<name> <sha>" lines are read and hashed so its place is kept).
# shellcheck disable=SC2016
REFS='
use strict; use warnings; use Digest::SHA qw(sha256_hex);
my %old; my $h = sub { substr(sha256_hex($_[0]), 0, 16) };
if (open(my $fh, "<", $ARGV[0])) {
  while (<$fh>) { chomp; my @f = split / /; if (@f == 3) { $old{$f[0]} = $f[2] } elsif (@f == 2) { $old{$h->("refs/remotes/$f[0]")} = $f[1] } }
}
while (<STDIN>) {
  chomp; next unless length;
  my ($ot, $o, $p, $pt, $name) = split /\t/, $_, 5; my ($kind, $short);
  if ($name eq "refs/remotes/origin/HEAD") { next }
  elsif ($name eq "refs/remotes/origin/main") { ($kind, $short) = ("main", "main") }
  elsif ($name =~ m{^refs/remotes/origin/(.+)$}) { ($kind, $short) = ("branch", $1) }
  elsif ($name =~ m{^refs/tags/(.+)$}) { ($kind, $short) = ("tag", $1) }
  else { next }
  my $k = $h->($name);
  print join(" ", $k, $kind, $ot, $o, (length $p ? $p : "-"), (length $pt ? $pt : "-"), ($old{$k} // "-"), $short), "\n";
}
'

FIRST=0
[ -f "$SEEN" ] || FIRST=1
pass() { # one fetch and check; 2 when something could not be checked (it is tried again next pass)
  local bad=0 new="$WHOME/seen.$$" refs work hash kind otype obj peeled ptype old name target keep c base oldc label h lbl
  fetch || return 2
  # main commits whose check failed before: again, every pass, until they pass
  if [ -s "$UNCHECKED" ]; then
    : > "$UNCHECKED.$$"
    while read -r h lbl c; do
      [ "$stopping" = 1 ] && { rm -f "$UNCHECKED.$$"; return 2; }
      git -C "$REPO" cat-file -e "$c^{commit}" 2>/dev/null || { say "NOTE $lbl is no longer on the remote; dropped from the unchecked list"; continue; }
      check "$h" "$lbl" "$c" || { printf '%s %s %s\n' "$h" "$lbl" "$c" >> "$UNCHECKED.$$"; bad=2; }
    done < "$UNCHECKED"
    mv "$UNCHECKED.$$" "$UNCHECKED"
  fi
  refs="$(git -C "$REPO" for-each-ref --format='%(objecttype)%09%(objectname)%09%(*objectname)%09%(*objecttype)%09%(refname)' refs/remotes/origin refs/tags)" ||
    { report_error list "could not list the refs; it runs again next pass"; return 2; }
  work="$(printf '%s\n' "$refs" | perl -e "$REFS" "$SEEN")" || { report_error list "could not compare the refs with what was seen"; return 2; }
  : > "$new"
  while read -r hash kind otype obj peeled ptype old name; do
    [ "$stopping" = 1 ] && { rm -f "$new"; return 2; }
    [ -n "$hash" ] || continue
    [ "$old" = - ] && old=""
    keep="$obj"
    if [ "$kind" = main ]; then
      if [ "$FIRST" = 0 ] && [ -n "$old" ] && [ "$old" != "$obj" ]; then
        if git -C "$REPO" cat-file -e "$old^{commit}" 2>/dev/null; then
          git -C "$REPO" rev-list --first-parent --reverse "$obj" "^$old" > "$WHOME/commits.$$" ||
            { report_error list "could not list the new main commits"; rm -f "$new" "$WHOME/commits.$$"; return 2; }
        else
          printf '%s\n' "$obj" > "$WHOME/commits.$$"
        fi
        while read -r c; do
          [ "$stopping" = 1 ] && break
          # a failed commit goes on the unchecked list; the mark still moves on, so later commits are checked
          if ! check "$hash" "main@${c:0:12}" "$c"; then
            [ "$stopping" = 1 ] && break
            bad=2
            reported_unchecked="$hash main@${c:0:12} $c"
            grep -qxF -- "$reported_unchecked" "$UNCHECKED" 2>/dev/null || printf '%s\n' "$reported_unchecked" >> "$UNCHECKED"
          fi
        done < "$WHOME/commits.$$"
        rm -f "$WHOME/commits.$$"
      fi
    elif [ "$old" != "$obj" ] && { [ "$FIRST" = 0 ] || [ "$SCAN_EXISTING" = 1 ]; }; then
      label="$kind@${obj:0:12}"
      target=""
      if [ "$otype" = commit ]; then target="$obj"; elif [ "$otype" = tag ] && [ "$ptype" = commit ]; then target="$peeled"; fi
      if [ -z "$target" ]; then
        key="$hash note $obj"
        if ! reported "$key"; then printf '%s\n' "$key" >> "$REPORTED"; say "NOTE $label points at no commit; it is not checked"; fi
      else
        base=""
        if [ -n "$old" ] && oldc="$(git -C "$REPO" rev-parse --verify -q "$old^{commit}" 2>/dev/null)" &&
          git -C "$REPO" merge-base --is-ancestor "$oldc" "$target" 2>/dev/null; then
          base="$oldc"
        fi
        tagobj=""
        [ "$otype" = tag ] && tagobj="$obj"
        # on a failure the old mark stays, so the whole check runs again next pass
        if ! check "$hash" "$label" "$target" "$base" "$name" "$tagobj"; then bad=2; keep="$old"; fi
      fi
    fi
    [ "$stopping" = 1 ] && { rm -f "$new"; return 2; }
    [ -n "$keep" ] && printf '%s %s %s\n' "$hash" "$kind" "$keep" >> "$new"
  done < <(printf '%s\n' "$work")
  mv "$new" "$SEEN" || { report_error seen "could not save what was seen"; return 2; }
  if [ "$FIRST" = 1 ]; then say "first pass: $(wc -l < "$SEEN" | tr -d ' ') branch and tag tips recorded; new commits from here on are checked"; fi
  FIRST=0
  return "$bad"
}

scan_main() {
  local r=0 sha n=0 notes=0 l s12 rest why
  take_lock
  r=$?
  case "$r" in
    0) fetch || exit 2 ;;
    1)
      [ -d "$REPO" ] || fatal "another watch ($LOCK_OWNER) is making the cache; try again in a minute"
      say "another watch ($LOCK_OWNER) holds the cache: checking main as it was last fetched"
      ;;
    *) fatal "could not take the lock" ;;
  esac
  sha="$(git -C "$REPO" rev-parse --verify -q "refs/remotes/origin/main^{commit}")" || fatal "no main in the cache"
  r=0
  run_timed "$CHECK_TIMEOUT" env CHECK_REPO="$REPO" CHECK_EXTRA_RULES="$RULES" bash "$HERE/check-ref-personal.sh" --tree "$sha" \
    > "$OUT" 2> "$CERR" < /dev/null || r=$?
  [ "$stopping" = 1 ] && { say "stopped"; exit 0; }
  case "$r" in 0 | 1) ;; *) why="$(why_failed)"; fatal "the check of main@${sha:0:12} failed (exit $r${why:+: $why})" ;; esac
  while IFS= read -r l; do
    case "$l" in
      'note: '*) notes=$((notes + 1)); say "NOTE main@${sha:0:12} ${l#note: }" ;;
      *) n=$((n + 1)); s12="${l%% *}" rest="${l#* }"; say "HIT main@${sha:0:12} $s12 $rest" ;;
    esac
  done < "$OUT"
  say "main@${sha:0:12}: $n hit(s), $notes note(s)"
  [ "$n" = 0 ] && exit 0
  exit 1
}

[ "$SCAN_MAIN" = 1 ] && scan_main

take_lock
case $? in
  0) ;;
  1) fatal "another watch ($LOCK_OWNER) already uses this cache folder" ;;
  *) fatal "could not take the lock" ;;
esac
# files an older watch kept, which held ref names
rm -f "$WHOME/refs" "$WHOME/refs.raw" "$WHOME/refs.now" "$WHOME/commits" "$WHOME/check.out" "$WHOME/seen.new"

say "watching (every ${INTERVAL}s; cache $WHOME)"
while :; do
  NEWHIT=0
  rc=0
  pass || rc=$?
  [ "$stopping" = 1 ] && { say "stopped"; exit 0; }
  if [ "$ONCE" = 1 ]; then
    [ "$rc" = 0 ] && rc=$NEWHIT
    exit "$rc"
  fi
  i=0
  while [ "$i" -lt $((INTERVAL * 5)) ] && [ "$stopping" = 0 ]; do
    sleep 0.2
    i=$((i + 1))
  done
  [ "$stopping" = 1 ] && { say "stopped"; exit 0; }
done
