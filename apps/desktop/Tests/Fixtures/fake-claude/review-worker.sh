# Review fixture (PR #68 review): a thread session with knobs. Never Claude Code. Every FAKE_RV_* is optional.
# FAKE_RV_NOISE=<comma list of threads>: print output until FAKE_RV_QUIET exists (a turn in progress: "busy").
# FAKE_RV_SIGLOG=<file>: log a SIGTERM and exit. FAKE_RV_IGNORE_TERM: ignore SIGTERM. FAKE_RV_BANNER: print this first.
# FAKE_RV_TOUCH_NOW / FAKE_RV_TOUCH_BOT + FAKE_RV_TOUCH_LATE: rewrite bot.pid at load / N seconds after ready, as the
# Telegram plugin does. FAKE_RV_NO_READY: never connect. FAKE_RV_EXIT_AFTER: exit 3 N seconds after ready.
# FAKE_RV_CHILD=<file>: leave a child in our group that ignores TERM/HUP and holds no tty (an MCP server on pipes).
# FAKE_RV_PWD=<file>: log the folder the session really runs in.
# FAKE_RV_DIALOG=<file>: once this file exists, draw a question with a cursor (a dialog that appears while live).
# FAKE_RV_SETSID_CHILD=<file>: leave a child in its own session, no tty (what Claude Code's Bash tool does: its shells are
# their own group with no tty, OBSERVED 2026-10-30). Logs its pid.
. "$(dirname "$0")/lib.sh"
T="$TALOS_APP_WORKER_THREAD"
noisy=""
case ",${FAKE_RV_NOISE:-}," in *",$T,"*) noisy=1 ;; esac
[ -n "${FAKE_RV_IGNORE_TERM:-}" ] && trap '' TERM
[ -n "${FAKE_RV_SIGLOG:-}" ] && trap 'echo "$T term" >> "$FAKE_RV_SIGLOG"; exit 0' TERM
[ -n "${FAKE_RV_BANNER:-}" ] && printf '%s\n' "$FAKE_RV_BANNER"
[ -n "${FAKE_RV_TOUCH_NOW:-}" ] && printf '%d' "$$" > "$FAKE_RV_TOUCH_NOW"
[ -n "${FAKE_WORKER_ENV_LOG:-}" ] && env | sort > "$FAKE_WORKER_ENV_LOG.$T"
[ -n "${FAKE_RV_PWD:-}" ] && pwd -P > "$FAKE_RV_PWD.$T"
if [ -n "${FAKE_RV_CHILD:-}" ]; then
  ( trap '' TERM HUP; exec /bin/sleep 60 ) </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_RV_CHILD.$T"
fi
if [ -n "${FAKE_RV_SETSID_CHILD:-}" ]; then
  ( exec /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "60"' ) </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_RV_SETSID_CHILD.$T"
fi
if [ -n "${FAKE_RV_DIALOG:-}" ]; then
  ( until [ -f "$FAKE_RV_DIALOG" ]; do sleep 0.1; done; printf '\n \342\235\257 1. Yes, I trust this folder\n   2. No, exit\n' ) &
fi
if [ -z "${FAKE_RV_NO_READY:-}" ]; then
  d="$TALOS_APP_HOME/workers/$T"
  mkdir -p "$d"
  printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$T" "$$" > "$d/ready"
fi
printf '\n > \n'
if [ -n "${FAKE_RV_TOUCH_LATE:-}" ]; then
  ( sleep "$FAKE_RV_TOUCH_LATE"; printf '%d' "$$" > "$FAKE_RV_TOUCH_BOT" ) &
fi
if [ -z "$noisy" ] && [ -z "${FAKE_RV_SIGLOG:-}" ] && [ -z "${FAKE_RV_EXIT_AFTER:-}" ] && [ -z "${FAKE_RV_IGNORE_TERM:-}" ]; then
  while IFS= read -r line; do
    printf '%s %s\n' "$T" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
  done
  idle
fi
exec 3<&0
( while IFS= read -r line <&3; do printf '%s %s\n' "$T" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"; done ) &
if [ -n "$noisy" ]; then
  ( while [ ! -f "${FAKE_RV_QUIET:-/nonexistent}" ]; do printf 'working\n'; sleep 0.1; done ) &
fi
if [ -n "${FAKE_RV_EXIT_AFTER:-}" ]; then
  sleep "$FAKE_RV_EXIT_AFTER"
  kill $(jobs -p) 2>/dev/null
  exit 3
fi
while :; do
  sleep "${FAKE_MAX_LIFETIME:-600}" &
  wait $!
  [ -n "${FAKE_RV_IGNORE_TERM:-}" ] || exit 0
done
