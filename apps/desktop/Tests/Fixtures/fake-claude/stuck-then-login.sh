# Confirms normally, then drops out of `agents --json` while staying alive (stuck). Each further Enter from the test: a login-expired
# dialog over that, then the session screen again (still unlisted).
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice; unregister
wait_enter; frame ' Not logged in · Please run /login'
wait_enter; print_notice
idle
