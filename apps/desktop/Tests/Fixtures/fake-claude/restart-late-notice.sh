# Start 1 confirms normally and crashes. The restart shows the dialog, takes the supervisor's Enter, and prints the registration notice
# only after a second Enter from the test, so a test can hold the screen unreadable while the notice is due.
. "$(dirname "$0")/lib.sh"
late() { show_dialog; wait_enter; wait_enter; print_notice; idle; }
crash_first_then late
