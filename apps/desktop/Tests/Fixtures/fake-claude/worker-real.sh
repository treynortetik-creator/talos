# A thread session that shows REAL Claude Code 2.1.318 screens: the files in ../real-2.1.318 are captures, printed back as they are.
# FAKE_REAL_START=trust|empty|draft|screen:<fixture>: the first screen (screen:<name> shows ../real-2.1.318/<name>.txt and then writes the hub's ready file, unless FAKE_REAL_NOT_READY is set). With trust, the screen becomes `empty` after the owner's Enter and the hub's ready file is written then (with
# FAKE_REAL_READY_FIRST it is written as soon as the dialog is drawn, before the Enter).
# FAKE_REAL_SWITCH=<file> with FAKE_REAL_THEN=<screen>: when that file appears, the screen changes to the named one. FAKE_REAL_SWITCH2 and
# FAKE_REAL_THEN2 do the same once more afterwards.
# An Enter while the trust dialog is up answers it. Every line typed into the pane is logged (FAKE_TYPED_LOG), and what is typed is drawn in
# the screen's input row (the `❯` + U+00A0 row of the fixture, its placeholder replaced), as Claude draws it; an Enter empties it again.
. "$(dirname "$0")/lib.sh"
D="$(cd "$(dirname "$0")/../real-2.1.318" && pwd)"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
ready() { printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"; }
cur=
show() {  # one whole screen, rows joined by CR LF, no final newline (the pane is 40 rows). $2: what is typed, drawn in the input row
  f="$D/$1.txt"; cur="$1"
  [ -f "$f" ] || f="$D/../synthetic/$1.txt"  # SYNTHETIC screens (../synthetic), for "another prompt of the same kind"
  local row=0
  [ -z "${2:-}" ] || row="$(LC_ALL=C grep -n $'\xe2\x9d\xaf\xc2\xa0' "$f" | tail -1 | cut -d: -f1)"
  printf '\033[2J\033[H'
  awk -v row="${row:-0}" -v t="${2:-}" 'NR>1{printf "\r\n"} NR==row {printf "\342\235\257\302\240%s", t; next} {printf "%s", $0}' "$f" | head -c 100000
}
# The screen is drawn BEFORE the ready file is written, as in real use (the bridge connects after Claude's UI is up, and a draft cannot
# exist before it). FAKE_REAL_DRAW_DELAY=<seconds> puts a pause between the two, so a manager that acts on ready alone sees a blank pane.
ready_after_draw() { [ -z "${FAKE_REAL_DRAW_DELAY:-}" ] || sleep "$FAKE_REAL_DRAW_DELAY"; ready; }
stty -echo -icanon min 1 time 0 2>/dev/null  # keys one at a time, drawn by show; before the ready file, so none is echoed by the tty
start="${FAKE_REAL_START:-empty}"
case "$start" in
  trust)
    show trust-dialog
    [ -n "${FAKE_REAL_READY_FIRST:-}" ] && ready  # ready under the dialog, never over a blank pane
    IFS= read -r _
    show empty-input
    ready_after_draw ;;
  screen:*) show "${start#screen:}"; [ -n "${FAKE_REAL_NOT_READY:-}" ] || ready_after_draw ;;
  *) if [ "$start" = draft ]; then show draft-input; else show empty-input; fi; ready_after_draw ;;
esac
switched=; switched2=; buf=""
while true; do
  if [ -z "$switched" ] && [ -n "${FAKE_REAL_SWITCH:-}" ] && [ -f "$FAKE_REAL_SWITCH" ]; then show "${FAKE_REAL_THEN:-empty-input}"; switched=1; fi
  if [ -n "$switched" ] && [ -z "$switched2" ] && [ -n "${FAKE_REAL_SWITCH2:-}" ] && [ -f "$FAKE_REAL_SWITCH2" ]; then show "${FAKE_REAL_THEN2:-empty-input}"; switched2=1; fi
  if IFS= read -rsn1 -t 1 ch; then
    case "$ch" in
      "") ;;  # the Enter, below
      $'\177'|$'\b') buf="${buf%?}"; show "$cur" "$buf"; continue ;;
      $'\033') IFS= read -rsn2 -t 1 _; continue ;;  # an escape sequence (the arrow keys): not drawn
      [[:cntrl:]]) continue ;;
      *) buf="$buf$ch"; show "$cur" "$buf"; continue ;;  # a key
    esac
    # an Enter on the trust dialog answers it (the highlighted row is `No, exit` in the real dialog, but here it only has to go away)
    if [ "$cur" = trust-dialog ]; then buf=""; show empty-input; ready; continue; fi
    printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$buf" >> "${FAKE_TYPED_LOG:-/dev/null}"
    buf=""
    show "$cur"  # the box is empty again after an Enter
  fi
done
