# Confirms normally and runs; one further Enter from the test drops it out of `agents --json` while it stays alive (stuck).
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
wait_enter; unregister
idle
