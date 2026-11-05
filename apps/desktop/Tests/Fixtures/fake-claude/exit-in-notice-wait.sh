# Start 1 confirms normally, crashes; the restart takes the Enter, then exits during the notice wait.
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog; wait_enter; sleep 1; exit 1'
