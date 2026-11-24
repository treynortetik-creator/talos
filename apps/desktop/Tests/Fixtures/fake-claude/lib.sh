# Shared pieces of the fake sessions. The dialog text is Claude Code 2.1.312's DevChannelsDialog (read from the binary):
# title, two body lines, "Channels: <list>", then a select with "I am using this for local development" / "Exit".
CHANNELS="${FAKE_CHANNELS:-server:talos-app}"
FLAG="--dangerously-load-development-channels"

show_dialog() {  # $1 = channels line, $2 = which row is highlighted (1 or 2)
  local ch="${1:-$CHANNELS}" hl="${2:-1}" a="  " b="  "
  if [ "$hl" = 1 ]; then a="❯ "; else b="❯ "; fi
  # Claude Code's Select reads keys raw and draws nothing for a key it ignores: no tty echo under the dialog (a key typed at the pane
  # must not turn up below the footer, where the real dialog never shows one); print_notice turns the echo back on
  stty -echo 2>/dev/null
  printf '\033[2J\033[H'
  printf ' WARNING: Loading development channels\n\n'
  printf ' %s is for local channel development only. Do not use this option to run channels you have downloaded off the internet.\n\n' "$FLAG"
  printf ' Please use --channels to run a list of approved channels.\n\n'
  printf ' Channels: %s\n\n' "$ch"
  printf ' %s1. I am using this for local development\n' "$a"
  printf ' %s2. Exit\n\n' "$b"
  printf ' Enter to confirm · Esc to cancel\n'
}

# One whole screen in a single write, so a read of the pane never catches it half drawn (blank).
frame() { printf '\033[2J\033[H%s\n' "$1"; }

wait_enter() { IFS= read -r _; }

print_notice() {  # the registration notice once channels are live, then Claude's input box (the supervisor reads the box, not the notice)
  stty echo 2>/dev/null
  printf '\033[2J\033[H'
  printf ' Channels (experimental) messages from %s inject directly in this session · restart without %s to stop\n\n' "$CHANNELS" "$FLAG"
  input_box
}

print_resumed() {  # a RESUMED session (Claude Code 2.1.319/2.1.322): the old conversation and the input box, no registration notice
  printf '\033[2J\033[H'
  printf ' > what is the plan for today?\n\n ● The plan: ship the fix, then review.\n\n'
  if [ -n "${FAKE_QUOTES:-}" ]; then  # a transcript that quotes dialog wording: it is conversation, not a dialog on the screen
    printf ' > what did the app print?\n\n ● It printed: Not logged in · Please run /login\n ● and: Yes, I trust this folder\n'
    printf ' ● and: WARNING: Loading development channels\n   Channels: server:talos-app\n'
    printf ' ❯ 1. I am using this for local development\n   2. Exit\n   Enter to confirm · Esc to cancel\n\n'
  fi
  input_box
}

# Claude Code's input box with nothing in it, as the real 2.1.318 capture draws it (../real-2.1.318/empty-input.txt): a rule row, `❯` + U+00A0
# + a space, a rule row, and the footer. The worker fakes print it where they once printed a bare ` > `, because the supervisor types
# its pointer only when this box is on the screen.
input_box() {
  local rule='────────────────────────────────────────────────'
  printf '%s\n\342\235\257\302\240 \n%s\n  \342\217\265\342\217\265 auto mode on (shift+tab to cycle)\n' "$rule" "$rule"
}

# `input_box` with the cursor on its input row, after the `❯` and U+00A0, where the pane's tty echoes what is typed (a worker fake reads
# its lines in cooked mode, so the echo is the only place the text could show): Claude draws a typed line in its box, and the
# supervisor sends an owed Enter only onto a box that holds its line. Row 1 of the box is three lines above the cursor.
typing_box() { input_box; printf '\033[3A\033[3G'; }

# The lines typed into a worker fake: each is logged (FAKE_TYPED_LOG) and the screen drawn again with the box empty, as Claude's is after an Enter.
log_typed_lines() {
  local line
  while IFS= read -r line; do
    printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
    printf '\033[2J\033[H\n'; typing_box
  done
}

# Whether this fake session may go on: every polling loop ends after FAKE_MAX_LIFETIME seconds (the rig sets 120), so a run that was killed
# before its teardown leaves nothing that spins for ever. (bash's SECONDS, counted from the start of the script; a subshell inherits it.)
fake_alive() { [ "$SECONDS" -lt "${FAKE_MAX_LIFETIME:-600}" ]; }

idle() { sleep "${FAKE_MAX_LIFETIME:-600}"; exit 0; }

unregister() { [ -n "${FAKE_AGENTS_DIR:-}" ] && rm -f "$FAKE_AGENTS_DIR/$$.json"; }

# A process in our own group that looks like the bridge, plus bridge.pid (and optionally bot.pid) pointing at it.
spawn_holder() {
  /bin/bash -c 'exec -a "bun apps/bridge/src/server.ts" /bin/sleep 600' &
  local hp=$!
  sleep 0.2
  if [ -n "${FAKE_BRIDGE_PID_FILE:-}" ]; then
    local ls; ls="$(LC_ALL=C ps -p "$hp" -o lstart= | sed 's/^ *//; s/ *$//')"
    printf '{"pid":%d,"started_at":"%s","instance":"fake"}' "$hp" "$ls" > "$FAKE_BRIDGE_PID_FILE"
  fi
  [ -n "${FAKE_BOT_PID_FILE:-}" ] && printf '%d' "$hp" > "$FAKE_BOT_PID_FILE"
  [ -n "${FAKE_HOLDER_LOG:-}" ] && echo "$hp" >> "$FAKE_HOLDER_LOG"
}

# The first start: the normal dialog, the (test-played) human Enter, the notice.
first_start_ok() { show_dialog; wait_enter; print_notice; }

# Waits $1 seconds, or, with FAKE_CRASH_ON_FILE set, until the test creates $FAKE_STATE_DIR/crash-now (a crash the test times itself,
# however long a loaded Mac pauses the test: the supervisor's first Enter after that file is the restart's).
crash_wait() {
  if [ -n "${FAKE_CRASH_ON_FILE:-}" ]; then
    for _ in $(seq 6000); do [ -e "$FAKE_STATE_DIR/crash-now" ] && return; sleep 0.05; done
  else
    sleep "$1"
  fi
}

# Start 1 confirms normally, then crashes after FAKE_CRASH_AFTER seconds (default 1). Later starts run "$@".
crash_first_then() {
  if [ "${FAKE_START_N:-1}" = 1 ]; then
    first_start_ok
    crash_wait "${FAKE_CRASH_AFTER:-1}"
    exit 1
  fi
  "$@"
}

# Where Claude Code keeps a conversation: <config dir>/projects/<folder, every non-alphanumeric as "-">/<id>.jsonl. It is written
# after the first message or an /exit, never at the start.
transcript_path() {  # $1 = session id
  local enc; enc="$(printf '%s' "$PWD" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
  printf '%s/projects/%s/%s.jsonl' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$enc" "$1"
}
save_transcript() {  # $1 = session id
  local f; f="$(transcript_path "$1")"
  mkdir -p "$(dirname "$f")" && printf '{"type":"user"}\n' >> "$f"
}

# Claude Code's two refusals about a session id (2.1.322), for the fakes that play them (unsaved-session.sh, worker-unsaved.sh):
# `--resume` of an id with no conversation, and `--session-id` of an id that has a file. Exits 1 after the error; returns otherwise.
session_id_rules() {
  local mode="" prev="" a f exists=0 talk=0
  for a in "$@"; do
    case "$prev" in --resume) mode=resume ;; --session-id) mode=new ;; esac
    case "$a" in --resume=*) mode=resume ;; --session-id=*) mode=new ;; esac
    prev="$a"
  done
  f="$(transcript_path "$FAKE_SESSION_ID")"
  # FAKE_EMPTY_FILE_FROM=<n>: from start n on, the id it is given has a file with no conversation in it (made here if missing)
  if [ -n "${FAKE_EMPTY_FILE_FROM:-}" ] && [ "${FAKE_START_N:-1}" -ge "$FAKE_EMPTY_FILE_FROM" ] && [ ! -f "$f" ]; then
    mkdir -p "$(dirname "$f")" && printf '{"type":"user","isMeta":true}\n' > "$f"
  fi
  [ -f "$f" ] && exists=1
  [ -f "$f" ] && grep -v '"isMeta":true' "$f" | grep -v '<command-name>' | grep -v '<local-command-' | grep -q '"type":"\(user\|assistant\)"' && talk=1
  if [ -n "${FAKE_REFUSE_SESSION_ID:-}" ] && [ "${FAKE_START_N:-1}" -ge "$FAKE_REFUSE_SESSION_ID" ]; then exists=1; talk=1; fi
  if [ "$mode" = resume ] && [ "$talk" = 0 ]; then echo "No conversation found with session ID: $FAKE_SESSION_ID"; sleep "${FAKE_ERROR_HOLD:-0.3}"; exit 1; fi
  if [ "$mode" = new ] && [ "$exists" = 1 ]; then echo "Error: Session ID $FAKE_SESSION_ID is already in use."; sleep "${FAKE_ERROR_HOLD:-0.3}"; exit 1; fi
}
