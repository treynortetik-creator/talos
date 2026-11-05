# Start 1 confirms normally, crashes; the restart shows the dialog, takes one Enter, then shows it again.
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog; wait_enter; show_dialog; wait_enter; print_notice; idle'
