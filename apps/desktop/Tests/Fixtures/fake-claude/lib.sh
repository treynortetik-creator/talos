# Shared pieces of the fake sessions. The dialog text is Claude Code 2.1.312's DevChannelsDialog (read from the binary):
# title, two body lines, "Channels: <list>", then a select with "I am using this for local development" / "Exit".
CHANNELS="${FAKE_CHANNELS:-server:talos-app}"
FLAG="--dangerously-load-development-channels"

show_dialog() {  # $1 = channels line, $2 = which row is highlighted (1 or 2)
  local ch="${1:-$CHANNELS}" hl="${2:-1}" a="  " b="  "
  if [ "$hl" = 1 ]; then a="❯ "; else b="❯ "; fi
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

print_notice() {  # the registration notice once channels are live
  printf '\033[2J\033[H'
  printf ' Channels (experimental) messages from %s inject directly in this session · restart without %s to stop\n' "$CHANNELS" "$FLAG"
  printf '\n > \n'
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

# Start 1 confirms normally, then crashes after FAKE_CRASH_AFTER seconds (default 1). Later starts run "$@".
crash_first_then() {
  if [ "${FAKE_START_N:-1}" = 1 ]; then
    first_start_ok
    sleep "${FAKE_CRASH_AFTER:-1}"
    exit 1
  fi
  "$@"
}
