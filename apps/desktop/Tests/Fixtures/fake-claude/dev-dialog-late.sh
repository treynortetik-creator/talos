# The first start is the normal dev-channel start. Every later start waits for $FAKE_STATE_DIR/show before it draws the dialog,
# so a test can decide which supervision pass is the first to see it.
. "$(dirname "$0")/lib.sh"
if [ -e "$FAKE_STATE_DIR/ran" ]; then
  for _ in $(seq 1200); do [ -e "$FAKE_STATE_DIR/show" ] && break; sleep 0.05; done
  [ -e "$FAKE_STATE_DIR/show" ] || exit 1
  show_dialog; wait_enter; print_notice; idle
else
  : > "$FAKE_STATE_DIR/ran"
  first_start_ok; idle
fi
