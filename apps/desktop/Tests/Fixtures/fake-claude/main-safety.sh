# Main on one of the two safety questions the Mac answers from its popup: the MCP server approval (FAKE_SAFETY=mcp, the REAL 2.1.319 captures,
# cursor on the LAST row, Up and Down move it and wrap) or the Bypass Permissions disclaimer (FAKE_SAFETY=bypass, SYNTHETIC frames drawn from the real
# 2.1.318 capture, cursor on "No, exit"). Every key from the pane is logged (FAKE_DLG_KEYLOG: ENTER, UP, DOWN, ESC, CHAR:<c>).
# FAKE_SAFETY_STICKY=1: an Enter is logged and the screen stays as it was.
# Enter: the input box (answered), except on the bypass disclaimer's "No, exit", where Claude exits.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
C="$here/../real-2.1.319/needs-you-capture"
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() { printf '\033[2J\033[H'; awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1" | head -c 100000; }
case "${FAKE_SAFETY:-mcp}" in
  bypass) files=("$here/../synthetic/bypass-disclaimer-0.ansi.txt" "$here/../synthetic/bypass-disclaimer-1.ansi.txt"); cur=0 ;;
  *) files=("$C/22-mcp-up2.ansi.txt" "$C/21-mcp-up.ansi.txt" "$C/20-mcp-first.ansi.txt"); cur=2 ;;
esac
n=${#files[@]}
stty -echo -icanon min 1 time 0 2>/dev/null
draw "${files[$cur]}"
while true; do
  IFS= read -rsn1 ch || exit 0
  case "$ch" in
    $'\033')
      IFS= read -rsn2 -t 1 seq
      case "$seq" in
        "[A"|"OA") keylog UP; cur=$(( (cur + n - 1) % n )); draw "${files[$cur]}" ;;
        "[B"|"OB") keylog DOWN; cur=$(( (cur + 1) % n )); draw "${files[$cur]}" ;;
        "") keylog ESC ;;
        *) keylog "ESC:$seq" ;;
      esac ;;
    "")
      keylog ENTER
      [ -z "${FAKE_SAFETY_STICKY:-}" ] || continue  # the screen does not redraw after the Enter (a lagging redraw, or a dead pane's last frame)
      if [ "${FAKE_SAFETY:-mcp}" = bypass ] && [ "$cur" = 0 ]; then exit 0; fi  # "No, exit"
      : > "$FAKE_STATE_DIR/safety-answered-$cur"
      printf '\033[2J\033[H'; input_box
      while IFS= read -rsn1 _; do keylog KEY; done ;;
    *) keylog "CHAR:$ch" ;;
  esac
done
