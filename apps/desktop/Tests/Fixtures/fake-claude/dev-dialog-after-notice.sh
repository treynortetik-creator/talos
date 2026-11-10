# The dev-channel dialog, Enter, the notice, and a second dev-channel dialog about a second later, while the start is already running.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
sleep 1
show_dialog
idle
