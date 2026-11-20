# Main or a thread session on a tool permission or the agent's own question (pane-prompts rows 8 and 9), drawn from the REAL 2.1.318 captures
# (../real-2.1.318: bash-permission, askuser-select) and the synthetic screens beside them (../synthetic). Every key from the pane is logged
# (FAKE_DLG_KEYLOG): DIGIT:<n>, UP, DOWN, ENTER, ESC, CHAR:<c>, and TEXT:<what was in the field> at the Enter that ends a typed answer.
#   FAKE_PANE=tool|tool-other|question|multi|garbled|question329|tool329 (the 329 ones: the REAL 2.1.329 captures; its free-text row is 4 and the focused footer differs)    which screen. `tool-other` is another command (../synthetic/bash-permission-other.txt).
#   FAKE_PANE_STICKY=1     a key is logged and the screen stays as it was (a redraw that lags, or a prompt that does not go away)
#   FAKE_PANE_SWAP=<file>  when that file appears the screen becomes the OTHER command's tool permission, as if another prompt took its place
# ASSUMED, not captured (docs/PANE-PROMPTS): a digit on a numbered Select row chooses it at once, and on `Type something.` it puts the cursor in the
# field instead (the field then shows what is typed, and Enter sends it). Unlike a real Select, a digit here is logged whatever row it names, so a
# test can see a key that should never have gone.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
R="$here/../real-2.1.318"; S="$here/../synthetic"; R329="$here/../real-2.1.329"
focus="$S/askuser-cursor-on-text.txt"; freedigit=3
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() { printf '\033[2J\033[H'; awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1" | head -c 100000; }
# the free-text row, holding what has been typed into it (the screen with the cursor on `3. Type something.`)
drawtext() { printf '\033[2J\033[H'; awk -v t="$buf" 'NR>1{printf "\r\n"} {sub(/Type something\./, t); printf "%s", $0}' "$focus" | head -c 100000; }
if [ -n "${TALOS_APP_WORKER_THREAD:-}" ]; then
  d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"; mkdir -p "$d"
  printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
fi
kind="${FAKE_PANE:-tool}"
case "$kind" in
  tool) file="$R/bash-permission.txt" ;;
  tool-other) file="$S/bash-permission-other.txt" ;;
  question) file="$R/askuser-select.txt" ;;
  question329) file="$R329/askuser-select.txt"; focus="$R329/askuser-field-focused.txt"; freedigit=4; kind=question ;;
  tool329) file="$R329/bash-permission.txt"; kind=tool ;;
  multi) file="$S/askuser-multi.txt" ;;
  garbled) file="$S/bash-permission-garbled.txt" ;;
esac
stty -echo -icanon min 1 time 0 2>/dev/null
draw "$file"
mode=select; buf=; swapped=
answered() { printf '\033[2J\033[H'; input_box; while IFS= read -rsn1 _; do keylog KEY; done; exit 0; }
while true; do
  if [ -z "$swapped" ] && [ -n "${FAKE_PANE_SWAP:-}" ] && [ -f "$FAKE_PANE_SWAP" ]; then swapped=1; file="$S/bash-permission-other.txt"; draw "$file"; fi
  IFS= read -rsn1 -t 1 ch || continue
  case "$ch" in
    $'\033') IFS= read -rsn2 -t 1 seq; case "$seq" in "[A"|"OA") keylog UP ;; "[B"|"OB") keylog DOWN ;; "") keylog ESC ;; *) keylog "ESC:$seq" ;; esac ;;
    "")
      if [ "$mode" = text ]; then
        keylog "TEXT:$buf"; keylog ENTER
        [ -z "${FAKE_PANE_STICKY:-}" ] || continue
        answered
      fi
      keylog ENTER ;;
    [0-9])
      keylog "DIGIT:$ch"
      [ -z "${FAKE_PANE_STICKY:-}" ] || continue
      if [ "$kind" = question ] && [ "$mode" = select ] && [ "$ch" = "$freedigit" ]; then
        mode=text; file="$focus"; draw "$file"
      elif [ "$mode" = select ]; then
        answered
      else
        buf="$buf$ch"; drawtext
      fi ;;
    *)
      keylog "CHAR:$ch"
      if [ "$mode" = text ]; then
        buf="$buf$ch"; drawtext
      fi ;;
  esac
done
