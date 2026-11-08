# Main's session, then a REAL Claude Code 2.1.318 screen (../real-2.1.318/$FAKE_PROMPT_SCREEN.txt) after the test's next Enter,
# and the plain notice screen after the Enter after that (the prompt answered).
. "$(dirname "$0")/lib.sh"
D="$(cd "$(dirname "$0")/../real-2.1.318" && pwd)"
show() {  # one whole screen in a single write, rows joined by CR LF, no final newline (the pane is 40 rows)
  printf '\033[2J\033[H'
  awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$D/$1.txt" | head -c 100000
}
first_start_ok
wait_enter; show "${FAKE_PROMPT_SCREEN:-bash-permission}"
wait_enter; print_notice
idle
