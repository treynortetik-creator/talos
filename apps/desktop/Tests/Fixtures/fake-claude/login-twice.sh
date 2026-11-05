# Confirms normally; each further Enter from the test moves it on: login expired, resolved, login expired again.
. "$(dirname "$0")/lib.sh"
login_dialog() { printf '\033[2J\033[H'; printf ' Not logged in · Please run /login\n\n'; }
show_dialog; wait_enter; print_notice
wait_enter; login_dialog
wait_enter; print_notice
wait_enter; login_dialog
idle
