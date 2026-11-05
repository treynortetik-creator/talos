# Confirms normally, then drops out of `agents --json` while staying alive (stuck).
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice; unregister; idle
