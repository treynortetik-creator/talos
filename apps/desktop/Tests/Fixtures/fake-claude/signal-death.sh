# Start 1 confirms normally, then kills itself with SIGKILL (a pane_dead_signal death). Later starts idle.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
if [ "${FAKE_START_N:-1}" = 1 ]; then sleep 0.5; kill -KILL $$; fi
idle
