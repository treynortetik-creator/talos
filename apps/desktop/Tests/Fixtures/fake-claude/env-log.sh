# Writes the environment this start got ($FAKE_STATE_DIR/env.log, one NAME=value per line), then the dev-channel dialog, the Enter, a resumed conversation (no notice).
. "$(dirname "$0")/lib.sh"
/usr/bin/env > "$FAKE_STATE_DIR/env.log"
show_dialog; wait_enter; print_resumed; idle
