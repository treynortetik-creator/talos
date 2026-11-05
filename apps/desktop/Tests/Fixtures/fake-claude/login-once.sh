# Confirms normally; one further Enter from the test shows a login-expired dialog.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
wait_enter; frame ' Not logged in · Please run /login'
idle
