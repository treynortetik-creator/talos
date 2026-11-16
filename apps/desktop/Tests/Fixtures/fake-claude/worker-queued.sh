# SYNTHETIC, drawn to match ../real-2.1.325-queued exactly: a thread session in a long turn (the status row says "esc to interrupt")
# that takes every line typed into it and queues it, as Claude Code 2.1.325 does. Once a line is queued, the empty box shows the DIM
# placeholder "Press up to edit queued messages" and the row under the box stays "⏸ manual mode on · 1 shell · esc to interrupt · ↓ to
# manage". The turn never ends here. Every line typed is logged (FAKE_TYPED_LOG).
. "$(dirname "$0")/lib.sh"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
RULE='────────────────────────────────────────────────────────────'
STATUS='  ⏸ manual mode on · 1 shell · esc to interrupt · ↓ to manage'
# the whole screen in one write, the cursor left in the box after the pointer and one space (where the tty echoes typing)
draw() {
  local box
  if [ "$1" = queued ]; then box=$(printf '\342\235\257 \033[2mPress up to edit queued messages\033[0m'); else box=$(printf '\342\235\257\302\240 '); fi
  printf '\033[2J\033[H❯ Write a 1500-word story about a lighthouse keeper.\n\n%s\n✻ Pondering… (thinking)\n\n%s\n%s\n%s\n%s\n\033[3A\033[3G' \
    "$QUEUED" "$RULE" "$box" "$RULE" "$STATUS"
}
QUEUED=''
draw empty
while IFS= read -r line; do
  printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
  QUEUED="$QUEUED❯ $line
"
  draw queued
done
idle
