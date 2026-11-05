# Start 1 confirms normally, crashes; the restart's dialog has the cursor on "Exit".
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog "" 2; wait_enter; print_notice; idle'
