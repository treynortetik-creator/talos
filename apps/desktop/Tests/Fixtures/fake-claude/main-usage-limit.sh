# Main and Claude Code's usage-limit screen, SYNTHETIC (../synthetic/usage-limit.txt: no real capture yet). Every key is logged from the
# moment the screen is drawn (FAKE_DLG_KEYLOG: ESC, ENTER, UP, DOWN, CHAR:<c>) and does nothing (on the real one, Enter on its third
# option spends usage credits).
#   default            Main starts as usual (the dev-channel warning, its Enter, the notice and the input box), then the screen is drawn when
#                      $FAKE_STATE_DIR/ul appears
#   FAKE_UL_UNLISTED=1  with the screen up, the session drops out of `agents --json` (still alive), as a session stuck on it may
#   FAKE_UL_AT_START=mixed   the start shows the dev-channel warning's words with the usage-limit screen drawn under them, at the bottom:
#                      the auto-accept must not press its Enter (it would land on the usage-limit screen)
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() { printf '\033[2J\033[H'; awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1"; }
if [ "${FAKE_UL_AT_START:-}" = mixed ]; then
  stty -echo -icanon min 1 time 0 2>/dev/null
  printf '\033[2J\033[H'
  printf ' WARNING: Loading development channels\r\n\r\n Channels: %s\r\n\r\n' "$CHANNELS"
  awk 'NR>9 && NR<=24{printf "%s\r\n", $0}' "$here/../synthetic/usage-limit.txt"
else
  show_dialog; wait_enter; print_notice
  while [ ! -f "$FAKE_STATE_DIR/ul" ]; do sleep 0.1; done
  stty -echo -icanon min 1 time 0 2>/dev/null
  draw "$here/../synthetic/usage-limit.txt"
  [ -z "${FAKE_UL_UNLISTED:-}" ] || unregister
fi
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
done
