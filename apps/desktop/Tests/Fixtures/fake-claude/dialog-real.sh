# A thread session that opens on one of the REAL Claude Code 2.1.319 dialogs (../real-2.1.319/needs-you-capture, the `.ansi.txt` copies: the
# colours the real dialog is drawn with) and behaves as the real Select does (OBSERVED in those captures): the cursor starts on the row the
# capture has it on (trust: "No, exit"; MCP consent: the LAST row), Up and Down move it and wrap at the ends, a digit does nothing, Enter on a
# row answers. The screen is drawn from the capture of that cursor position, so what a reader sees is what Claude drew.
#   FAKE_DLG=trust|mcp|mcpwrap|login   the dialog (login: the real not-logged-in screen with its input box, no select; mcpwrap: the MCP dialog with a server
#                              name wrapped over two rows, SYNTHETIC: ../synthetic)
#   FAKE_DLG_KEYLOG=<file>     every key the pane receives, one per line: UP, DOWN, ENTER, CHAR:<c> (the tests read what was pressed)
#   FAKE_DLG_LATE=<file>       start as a normal session (the input box, the ready file) and show the dialog when that file appears; keys
#                              before that are logged as PRE:<key>
#   FAKE_DLG_SWAP=<file>       when that file appears the screen becomes FAKE_DLG_SWAP_TO (mcp | trust-changed | trust-other), as if Claude
#                              had put up another dialog in place of this one (SYNTHETIC for the last two: ../synthetic)
#   FAKE_DLG_AGAIN=1           the first Enter on an MCP dialog is followed at once by a second dialog that looks the same (another wrapped server name), as when
#                              a project names two servers; the second Enter answers. FAKE_DLG_AGAIN=same: the second dialog is the SAME screen
#                              again (same server name, same rows, the cursor back on its first row), as a dialog that replaced the first and reads alike
#   FAKE_DLG_STICKY=1          an Enter is logged and does nothing (a dialog that does not go away), to see a second Enter never sent
#   FAKE_DLG=cu                the REAL 2.1.322 computer-use permission dialog (../real-2.1.322). With FAKE_DLG_LATE it shows when that file
#                              appears and removes the file, so a test can raise it again. A lone Escape is logged as ESC and draws the real
#                              screen after Escape (the turn went on); with FAKE_DLG_STICKY=1 it is logged and the dialog stays. Any other
#                              key is logged and does nothing here (on the real one, Enter would open System Settings).
#   FAKE_DLG=ul                Claude Code's usage-limit screen, SYNTHETIC (../synthetic/usage-limit.txt: no real capture yet). With FAKE_DLG_LATE it
#                              shows when that file appears and removes the file. EVERY key is logged and does nothing (on the real one, Enter on
#                              its third option spends usage credits). FAKE_DLG_UL_END=<file>: when that file appears the screen goes (the idle box,
#                              ../synthetic/usage-limit-after-esc.txt), as if the owner had pressed Esc at the Mac.
# Enter on trust "Yes, I trust this folder" or on any MCP row: the input box (worker-real.sh's `empty` screen, with its ready file and
# typed-line log). Enter on trust "No, exit": Claude exits.
# The captures are pane-sized (40 rows), joined by CR LF with no final newline, like worker-real.sh draws its screens.
. "$(dirname "$0")/lib.sh"
here="$(cd "$(dirname "$0")" && pwd)"
C="$here/../real-2.1.319/needs-you-capture"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
ready() { printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"; }
pre=
keylog() { [ -z "${FAKE_DLG_KEYLOG:-}" ] || printf '%s%s\n' "${pre:+PRE:}" "$1" >> "$FAKE_DLG_KEYLOG"; }
draw() {  # one whole screen from a file: rows joined by CR LF, no final newline
  printf '\033[2J\033[H'
  awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$1" | head -c 100000
}
# the capture for each cursor position
trust_files=("$C/01-trust-first.ansi.txt" "$C/02-trust-down.ansi.txt")
mcp_files=("$C/22-mcp-up2.ansi.txt" "$C/21-mcp-up.ansi.txt" "$C/20-mcp-first.ansi.txt")
kind="${FAKE_DLG:-trust}"
files=(); cur=0
case "$kind" in
  trust) files=("${trust_files[@]}"); cur=0 ;;
  mcp) files=("${mcp_files[@]}"); cur=2 ;;
  mcpwrap) files=("$here/../synthetic/mcp-wrapped-a-0.ansi.txt" "$here/../synthetic/mcp-wrapped-a-1.ansi.txt" "$here/../synthetic/mcp-wrapped-a-2.ansi.txt"); cur=2; kind=mcp ;;
  login) files=("$C/10-trust-after-enter.ansi.txt") ;;
  cu) files=("$here/../real-2.1.322/computer-use-permissions.txt") ;;
  ul) files=("$here/../synthetic/usage-limit.txt") ;;
esac
again=${FAKE_DLG_AGAIN:-}
swap_to() {
  case "$1" in
    mcp) files=("${mcp_files[@]}"); cur=2; kind=mcp ;;
    trust-changed) files=("$here/../synthetic/trust-changed-option.ansi.txt"); cur=0; kind=trust ;;
    trust-other) files=("$here/../synthetic/trust-other-folder.ansi.txt"); cur=0; kind=trust ;;
  esac
  draw "${files[$cur]}"
}
stty -echo -icanon min 1 time 0 2>/dev/null
if [ -n "${FAKE_DLG_LATE:-}" ]; then
  pre=1
  draw "$here/../real-2.1.318/empty-input.txt"
  ready
else
  draw "${files[$cur]}"
  [ "$kind" != login ] || ready
fi
swapped=
n=${#files[@]}
while true; do
  if [ -n "$pre" ] && [ -f "$FAKE_DLG_LATE" ]; then
    pre=; draw "${files[$cur]}"
    { [ "$kind" != cu ] && [ "$kind" != ul ]; } || rm -f "$FAKE_DLG_LATE"
  fi
  if [ "$kind" = ul ] && [ -z "$pre" ] && [ -n "${FAKE_DLG_UL_END:-}" ] && [ -f "$FAKE_DLG_UL_END" ]; then
    rm -f "$FAKE_DLG_UL_END"; draw "$here/../synthetic/usage-limit-after-esc.txt"; [ -z "${FAKE_DLG_LATE:-}" ] || pre=1
  fi
  if [ -z "$pre" ] && [ -z "$swapped" ] && [ -n "${FAKE_DLG_SWAP:-}" ] && [ -f "$FAKE_DLG_SWAP" ]; then
    swapped=1; swap_to "${FAKE_DLG_SWAP_TO:-mcp}"; n=${#files[@]}
  fi
  if IFS= read -rsn1 -t 1 ch; then
    case "$ch" in
      $'\033')
        IFS= read -rsn2 -t 1 seq
        if [ "$kind" = ul ]; then keylog "ESC${seq:+:$seq}"; continue; fi  # the usage-limit screen: logged, nothing happens
        if [ "$kind" = cu ] && [ -z "$seq" ]; then  # a lone Escape
          keylog ESC
          [ -n "$pre" ] || [ -n "${FAKE_DLG_STICKY:-}" ] || { draw "$here/../real-2.1.322/computer-use-permissions-after-esc.txt"; [ -z "${FAKE_DLG_LATE:-}" ] || pre=1; }
          continue
        fi
        case "$seq" in
          "[A"|"OA") keylog UP; [ -n "$pre" ] || [ "$kind" = login ] || { cur=$(( (cur + n - 1) % n )); draw "${files[$cur]}"; } ;;
          "[B"|"OB") keylog DOWN; [ -n "$pre" ] || [ "$kind" = login ] || { cur=$(( (cur + 1) % n )); draw "${files[$cur]}"; } ;;
          *) keylog "ESC:$seq" ;;
        esac ;;
      "")  # Enter
        keylog ENTER
        { [ -n "$pre" ] || [ "$kind" = login ] || [ "$kind" = cu ] || [ "$kind" = ul ] || [ -n "${FAKE_DLG_STICKY:-}" ]; } && continue
        if [ "$kind" = trust ] && [ "$cur" = 0 ]; then exit 0; fi   # "No, exit"
        if [ -n "$again" ]; then
          [ "$again" = same ] || files=("$here/../synthetic/mcp-wrapped-b-0.ansi.txt" "$here/../synthetic/mcp-wrapped-b-1.ansi.txt" "$here/../synthetic/mcp-wrapped-b-2.ansi.txt")
          again=; cur=2; n=3
          draw "${files[$cur]}"
          continue
        fi
        # answered: the input box, ready, and the typed-line log of a normal session
        FAKE_REAL_START=empty exec /bin/bash "$here/worker-real.sh" ;;
      *) keylog "CHAR:$ch" ;;  # a digit or a letter: the real Select does nothing with it
    esac
  fi
done
