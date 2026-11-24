# A thread session (Option C). No dialog: it plays the hub's part by writing the ready file the live bridge would write
# after the worker's `hello`, shows a prompt, and logs every line typed into it. FAKE_WORKER_ENV_LOG gets its env.
. "$(dirname "$0")/lib.sh"
for a in "$@"; do
  if [ "$a" = "--resume" ] && [ -n "${FAKE_RESUME_MISSING:-}" ]; then
    echo "${FAKE_RESUME_LINE:-No session found with ID} ${FAKE_SESSION_ID}"
    [ -n "${FAKE_RESUME_EXIT_NOW:-}" ] || sleep 0.3  # FAKE_RESUME_EXIT_NOW: exit before the host can read a pid
    exit 1
  fi
done
[ -n "${FAKE_WORKER_ENV_LOG:-}" ] && env | sort > "$FAKE_WORKER_ENV_LOG.$TALOS_APP_WORKER_THREAD"
if [ -n "${FAKE_WORKER_TOUCH_BOT:-}" ]; then
  # what the Telegram plugin does at load when it starts in a worker: rewrite bot.pid to itself
  printf '%d' "$$" > "$FAKE_WORKER_TOUCH_BOT"
fi
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
# FAKE_WORKER_BG=<dir>: when <dir>/<thread>.server exists at the start, a stand-in for an MCP server runs under the session (not a
# shell, as a real server is not); when <dir>/<thread>.run exists, a Bash tool command is left running in the background, as Claude
# Code starts one (a shell, `-c`, a snapshot sourced, the command inside `eval '...'`); it ends when <dir>/<thread>.done exists, when <dir> is
# gone (a run that died before its teardown must not loop for ever), or after FAKE_MAX_LIFETIME seconds (600 when unset; zsh's $SECONDS).
if [ -n "${FAKE_WORKER_BG:-}" ] && [ -f "$FAKE_WORKER_BG/$TALOS_APP_WORKER_THREAD.server" ]; then
  /bin/sleep "${FAKE_MAX_LIFETIME:-600}" </dev/null >/dev/null 2>&1 &
fi
if [ -n "${FAKE_WORKER_BG:-}" ] && [ -f "$FAKE_WORKER_BG/$TALOS_APP_WORKER_THREAD.run" ]; then
  done_file="$FAKE_WORKER_BG/$TALOS_APP_WORKER_THREAD.done"
  # detached, as Claude Code 2.1.325 starts it: its own process group and session (a signal to the session's group does not reach it)
  /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec @ARGV' /bin/zsh -c \
    "source /nonexistent/snapshot-zsh.sh 2>/dev/null || true && eval 'until [ -f \"$done_file\" ] || [ ! -d \"$FAKE_WORKER_BG\" ] || [ \$SECONDS -ge ${FAKE_MAX_LIFETIME:-600} ]; do sleep 0.2; done' < /dev/null" \
    </dev/null >/dev/null 2>&1 &
  bg_pid=$!
  # the CLI ends its own tasks as it exits on a SIGTERM (the 2026-11-15 report: the waker died with the park); a SIGKILL leaves them
  trap 'kill "$bg_pid" 2>/dev/null; exit 143' TERM
fi
printf '\n'; typing_box
log_typed_lines
idle
