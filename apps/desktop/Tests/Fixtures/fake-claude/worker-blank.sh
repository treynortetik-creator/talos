# A thread session whose hub connects BEFORE Claude's screen is drawn (what a new thread folder does when the MCP server connects under
# the trust dialog, or before the UI is up): the ready file is written first and the pane stays blank. The input box is drawn when
# the file "$FAKE_BLANK_BOX.1" appears (FAKE_BLANK_BOX is a path prefix). Every line typed into the pane is logged (FAKE_TYPED_LOG),
# blank or not: a line typed over the blank pane is the failure this fake exists to catch.
# FAKE_BLANK_REPEAT=1: after each typed line the pane goes blank again, and the box comes back when "$FAKE_BLANK_BOX.<n+1>" appears.
. "$(dirname "$0")/lib.sh"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
blank() { printf '\033[2J\033[H'; }
blank
printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
(
  k=1
  while :; do
    until [ -f "$FAKE_BLANK_BOX.$k" ]; do sleep 0.1; done
    blank; typing_box
    [ -n "${FAKE_BLANK_REPEAT:-}" ] || break
    k=$((k + 1))
  done
) &
while IFS= read -r line; do
  printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
  if [ -z "${FAKE_BLANK_REPEAT:-}" ]; then printf '\033[2J\033[H'; typing_box; else blank; fi  # the box is empty again after an Enter
done
idle
