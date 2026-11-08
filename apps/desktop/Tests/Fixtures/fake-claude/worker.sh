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
printf '\n'; typing_box
log_typed_lines
idle
