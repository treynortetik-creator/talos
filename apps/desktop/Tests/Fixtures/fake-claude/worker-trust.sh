# SYNTHETIC (hand-drawn, numbered options): only for what no real capture exists for: a login dialog, and a dialog that flaps.
# The trust dialog and the input box are tested with ../real-2.1.318 through worker-real.sh.
# A thread session that opens on the folder-trust dialog (Option C smoke O5) and waits for the owner. The Enter the owner types
# in the pane answers it: the screen clears, the ready file the hub writes appears, and every line typed afterwards is logged.
# FAKE_TRUST_READY_FIRST=1: the bridge connected underneath the dialog (the ready file is already there).
# FAKE_TRUST_LATE=<file>: start as a normal session, and show the dialog when that file appears.
. "$(dirname "$0")/lib.sh"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
ready() { printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"; }
RULE='────────────────────────────────────────────────'
dialog() {
  printf '\033[2J\033[H'
  printf ' %s\n Accessing workspace:\n\n /tmp/proj\n\n Quick safety check: Is this a project you created or one you trust?\n\n' "$RULE"
  [ -n "${FAKE_TRUST_LOGIN:-}" ] && { printf ' Not logged in · Please run /login\n\n ❯ 1. Claude account with subscription\n   2. Anthropic Console account\n\n Enter to confirm · Esc to cancel\n'; return; }
  printf ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n'
}
if [ -n "${FAKE_TRUST_FLAP:-}" ]; then
  # the dialog comes and goes, as often as the test likes, on a running session
  ready
  printf '\n'; typing_box
  until [ -f "$FAKE_TRUST_FLAP" ]; do sleep 0.2; done
  while true; do
    dialog; sleep 2
    printf '\033[2J\033[H\n'; typing_box; sleep 2
  done
fi
if [ -n "${FAKE_TRUST_LATE:-}" ]; then
  ready
  printf '\n'; typing_box
  until [ -f "$FAKE_TRUST_LATE" ]; do sleep 0.2; done
  while IFS= read -r -t 1 line; do  # the pointer typed before the dialog
    printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
    printf '\033[2J\033[H\n'; typing_box
  done
  dialog
  IFS= read -r _
  printf '\033[2J\033[H\n'; typing_box
else
  dialog
  [ -n "${FAKE_TRUST_READY_FIRST:-}" ] && ready  # ready under the dialog, never over a blank pane
  IFS= read -r _
  printf '\033[2J\033[H'
  ready
  printf '\n'; typing_box
fi
log_typed_lines
idle
