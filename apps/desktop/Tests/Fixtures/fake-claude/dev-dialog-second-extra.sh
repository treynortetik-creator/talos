# Start 1 is the normal dev-channel start. Every later start shows the dialog with an extra channel next to the real one.
. "$(dirname "$0")/lib.sh"
if [ "${FAKE_START_N:-1}" = 1 ]; then
  first_start_ok; idle
else
  show_dialog "server:talos-app, server:talos-app-evil"; wait_enter; print_notice; idle
fi
