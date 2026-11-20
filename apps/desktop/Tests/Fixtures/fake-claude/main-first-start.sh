# Main's first start, on the REAL 2.1.322 first-start captures (../real-first-start-2.1.322): the theme picker, the security notes, then the
# screen after a sign-in (../synthetic/first-start-login-success.txt, hand-written: there is no real capture of it), each drawn alone and
# left until a key arrives. FAKE_FS_END picks what stays on the pane at the end: `api-key` (the question; UP and DOWN move its cursor, which
# is what Claude Code's own select does), `login-hint` (the real signed-out hint), `quote` (a conversation quoting "Run /login"), `login-method` (a sign-in screen nothing answers) or `ready` (the input box).
# Every key from the pane is logged (FAKE_DLG_KEYLOG: ENTER, UP, DOWN, ESC, CHAR:<c>).
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
real="$here/../real-first-start-2.1.322"
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s\n' "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() { printf '\033[2J\033[H'; awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1"; }
readkey() {
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
}
stty -echo -icanon min 1 time 0 2>/dev/null
for screen in "$real/theme.txt" "$real/security-notes.txt" "$here/../synthetic/first-start-login-success.txt"; do
  draw "$screen"
  until [ "$k" = ENTER ]; do readkey; done
  k=
done
case "${FAKE_FS_END:-ready}" in
  # the real "Not logged in · Run /login" hint under the live input box (../real-first-start-2.1.322/not-logged-in.txt)
  login-hint) draw "$real/not-logged-in.txt"; while :; do readkey; done ;;
  # a conversation that QUOTES the words, above a live, signed-in input box: nothing to sign in to
  quote)
    frame " ● It printed: Not logged in · Run /login
 ● and: Please run /login · API Error: 401
"
    printf '\n'; input_box; while :; do readkey; done ;;
  login-method) draw "$real/login-method.txt"; while :; do readkey; done ;;
  api-key)
    yes_up() { sed -e 's/^    Yes/  ❯ Yes/' -e 's/^  ❯ No (recommended)/    No (recommended)/' "$real/api-key.txt"; }
    draw "$real/api-key.txt"
    pos=no
    while :; do
      readkey
      case "$k" in
        UP) pos=yes; yes_up > "$FAKE_STATE_DIR/api-yes.txt"; draw "$FAKE_STATE_DIR/api-yes.txt" ;;
        DOWN) pos=no; draw "$real/api-key.txt" ;;
        ENTER) frame " (answered: $pos)"; : > "$FAKE_STATE_DIR/api-answered-$pos"; while :; do readkey; done ;;
      esac
    done ;;
  *) print_notice; while :; do readkey; done ;;
esac
