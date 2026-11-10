# The dev-channel dialog as the real Select behaves: Up and Down move the highlight between the two rows, Enter on row 1 confirms (the notice,
# then idle), Enter on row 2 ("Exit") exits. Every key is logged (FAKE_DLG_KEYLOG, one per line: UP, DOWN, ENTER, ESC), so a test sees what was pressed.
# FAKE_STICKY=1: an Enter is logged and does nothing (a dialog that is slow to go: a second key would be a second Enter). FAKE_STICKY_EXIT=1: the same for Enter on "Exit" only.
# FAKE_START_ROW=2 starts with "Exit" highlighted (a wrong highlight: the auto-accept refuses it, a card tap walks up to the other row).
. "$(dirname "$0")/lib.sh"
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
stty -echo -icanon min 1 time 0 2>/dev/null
hl="${FAKE_START_ROW:-1}"
show_dialog "$CHANNELS" "$hl"
while :; do
  IFS= read -rsn1 k || exit 0
  if [ "$k" = $'\e' ]; then
    IFS= read -rsn2 -t 1 rest
    case "$rest" in "[A" | "OA") k=UP ;; "[B" | "OB") k=DOWN ;; *) k=ESC ;; esac
  elif [ -z "$k" ] || [ "$k" = $'\r' ]; then
    k=ENTER
  else
    k="CHAR:$k"
  fi
  keylog "$k"
  case "$k" in
    UP) hl=1; show_dialog "$CHANNELS" 1 ;;
    DOWN) hl=2; show_dialog "$CHANNELS" 2 ;;
    ENTER)
      [ -n "${FAKE_STICKY:-}" ] && continue
      [ "$hl" = 2 ] && [ -n "${FAKE_STICKY_EXIT:-}" ] && continue
      if [ "$hl" = 1 ]; then print_notice; idle; else exit 0; fi ;;
  esac
done
