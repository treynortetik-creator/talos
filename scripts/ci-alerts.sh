#!/usr/bin/env bash
# The messages ci-runner.sh leaves for the lead (main went red, is green again, has gone untested, or its Linux report did), in
# ~/.cache/talos-ci/alerts/ (or TALOS_CI_CACHE). The runner can't send a message and must never open the live Talos home, so a
# session on this Mac passes them on: it runs `watch` as a Monitor, and each line it prints is one message to pass on.
#
#   scripts/ci-alerts.sh watch [--once]   print each waiting message (one line, with its id) once per watcher; every 15 s.
#                                         A heartbeat every minute; ci-runner.sh untested, lead-inbox.sh flush every 10 min.
#   scripts/ci-alerts.sh ack <id>...      after passing a message on: move it to alerts/sent/. Nothing else marks it sent.
#   scripts/ci-alerts.sh list             the messages not acked yet; exit 1 when something is wrong: no heartbeat, or
#                                         one over 5 minutes old (the watcher is not running), or a message waiting over 15 min
#
# Printed is not delivered: a Monitor is killed after 30 minutes and re-armed, and a line it took in but had not yet passed on
# dies with it. So a message waits until the session acks it, and each new watcher offers every waiting one again (a duplicate,
# never a loss). Run `watch` bare under the Monitor, with no filter after it: Claude Code's `grep` is ugrep, whose
# `-v --line-buffered` holds the lines until its input ends, which for a watcher is the Monitor's kill (how 1794578701-a26e55f-red
# was lost on 2026-11-13).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}/alerts"

offered=" "
offer() { # print each waiting message this watcher has not printed yet; it stays waiting until `ack`
  local f id
  for f in "$DIR"/*.txt; do
    [ -f "$f" ] || continue
    id="${f##*/}" && id="${id%.txt}"
    case "$offered" in *" $id "*) continue ;; esac
    printf 'CI ALERT %s: %s (full text: %s; once passed on: %s ack %s)\n' "$id" "$(head -1 "$f")" "$f" "$HERE/ci-alerts.sh" "$id" &&
      offered="$offered$id "
  done
}
beat() { mkdir -p "$DIR" && date +%s > "$DIR/.heartbeat.part" && mv -f "$DIR/.heartbeat.part" "$DIR/.heartbeat"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; } # GNU first: its -f prints something else

case "${1:-}" in
  watch)
    if [ "${2:-}" = --once ]; then beat; offer; exit 0; fi
    last_beat=0 last_check=0 check="" last_flush=0 flush=""
    while :; do
      now=$(date +%s)
      if [ $((now - last_beat)) -ge 60 ]; then beat; last_beat=$now; fi
      # in the background, one at a time: a slow or hung gh never stops the heartbeat or the messages
      if [ $((now - last_check)) -ge 600 ] && { [ -z "$check" ] || ! kill -0 "$check" 2>/dev/null; }; then
        bash "$HERE/ci-runner.sh" untested >/dev/null 2>&1 &
        check=$! last_check=$now
      fi
      # the same for the lead's inbox on GitHub: post what the runner's own post missed (scripts/lead-inbox.sh flush); a group
      # time limit of 5 minutes, so a hung gh never stops every later flush
      if [ $((now - last_flush)) -ge 600 ] && { [ -z "$flush" ] || ! kill -0 "$flush" 2>/dev/null; }; then
        # shellcheck disable=SC2016
        perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' \
          300 bash "$HERE/lead-inbox.sh" flush >/dev/null 2>&1 &
        flush=$! last_flush=$now
      fi
      offer
      sleep "${TALOS_CI_ALERTS_EVERY:-15}" # a test's knob
    done
    ;;
  ack)
    shift
    [ "$#" -gt 0 ] || { sed -n '8p' "$0" | sed 's/^# *//' >&2; exit 64; }
    rc=0
    for id in "$@"; do
      id="${id%.txt}"
      case "$id" in '' | */* | .*) echo "ci-alerts: not an alert id: $id" >&2; exit 64 ;; esac
      if [ -f "$DIR/$id.txt" ]; then
        mkdir -p "$DIR/sent" && mv -f "$DIR/$id.txt" "$DIR/sent/$id.txt" && echo "acked $id" || rc=1
      elif [ -f "$DIR/sent/$id.txt" ]; then
        echo "$id was already acked"
      else
        echo "ci-alerts: no alert $id in $DIR" >&2
        rc=1
      fi
    done
    exit "$rc"
    ;;
  list)
    now=$(date +%s) problem=0 found=0
    hb="$(cat "$DIR/.heartbeat" 2>/dev/null)"
    case "$hb" in
      '' | *[!0-9]*) echo "problem: no watcher heartbeat in $DIR (is a session running scripts/ci-alerts.sh watch?)"; problem=1 ;;
      *) if [ $((now - hb)) -gt 300 ]; then
          echo "problem: the watcher's heartbeat is $(((now - hb) / 60)) min old (its session has stopped watching)"
          problem=1
        fi ;;
    esac
    for f in "$DIR"/*.txt; do
      [ -f "$f" ] || continue
      found=1
      echo "$f"
      t="$(mtime "$f")"
      if [ -n "$t" ] && [ $((now - t)) -gt 900 ]; then
        echo "problem: ${f##*/} has waited $(((now - t) / 60)) min without being acked"
        problem=1
      fi
    done
    [ "$found" = 1 ] || echo "nothing waiting in $DIR"
    exit "$problem"
    ;;
  *)
    sed -n '6,10p' "$0" | sed 's/^# *//' >&2
    exit 64
    ;;
esac
