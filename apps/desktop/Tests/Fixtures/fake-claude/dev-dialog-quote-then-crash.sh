# Start 1 shows the dev-channel dialog, is never answered, and after $FAKE_CRASH_AFTER seconds (default 3) prints the CLI's resume
# error on a line of its own and exits 1. Later starts show the dialog and wait.
. "$(dirname "$0")/lib.sh"
show_dialog
if [ "${FAKE_START_N:-1}" = 1 ]; then
  sleep "${FAKE_CRASH_AFTER:-3}"
  printf '\033[2J\033[HNo session found with ID %s\n' "${FAKE_SESSION_ID}"
  sleep 0.3
  exit 1
fi
wait_enter; print_notice; idle
