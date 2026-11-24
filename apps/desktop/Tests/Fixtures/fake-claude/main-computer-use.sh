# Main starts as usual (the dev-channel warning, its Enter, the notice and the input box), then, when $FAKE_STATE_DIR/cu appears, the REAL
# Claude Code 2.1.322 computer-use permission dialog (../real-2.1.322/computer-use-permissions.txt) is drawn, as when a tool called
# request_access. Every key from then on is logged (FAKE_DLG_KEYLOG: ESC, ENTER, UP, DOWN, CHAR:<c>). A lone Escape draws the real screen
# after Escape (the turn went on to its idle box); any other key does nothing (on the real dialog Enter opens System Settings).
# FAKE_DLG_STICKY=1: an Escape is logged and the dialog stays (one that did not take), so Main is left needs-you on it.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() { printf '\033[2J\033[H'; awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1"; }
show_dialog; wait_enter; print_notice
while [ ! -f "$FAKE_STATE_DIR/cu" ] && fake_alive; do sleep 0.1; done
stty -echo -icanon min 1 time 0 2>/dev/null
draw "$here/../real-2.1.322/computer-use-permissions.txt"
while :; do
  IFS= read -rsn1 k || exit 0
  if [ "$k" = $'\e' ]; then
    IFS= read -rsn2 -t 1 rest
    case "$rest" in "[A" | "OA") k=UP ;; "[B" | "OB") k=DOWN ;; "") k=ESC ;; *) k="ESC:$rest" ;; esac
  elif [ -z "$k" ] || [ "$k" = $'\r' ]; then
    k=ENTER
  else
    k="CHAR:$k"
  fi
  keylog "$k"
  [ "$k" = ESC ] && [ -z "${FAKE_DLG_STICKY:-}" ] && draw "$here/../real-2.1.322/computer-use-permissions-after-esc.txt"
done
