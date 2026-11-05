# Start 1 confirms normally, crashes; the restart takes the Enter but never prints the notice.
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog; wait_enter; printf "\033[2J\033[H working…\n"; idle'
