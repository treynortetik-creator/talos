# Nothing on screen until $FAKE_STATE_DIR/show exists (a test decides when the dialog appears, and what the clock and the clients are by then),
# then the dev-channel dialog, wait for Enter, the notice, idle.
. "$(dirname "$0")/lib.sh"
for _ in $(seq 2400); do [ -e "$FAKE_STATE_DIR/show" ] && break; sleep 0.05; done
[ -e "$FAKE_STATE_DIR/show" ] || exit 1
show_dialog; wait_enter; print_notice; idle
