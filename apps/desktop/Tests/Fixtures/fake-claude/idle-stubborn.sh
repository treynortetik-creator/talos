# A session with no dialog that ignores SIGTERM (the ignore is inherited by what it runs), so a stop sits in its grace period
# until the SIGKILL. It touches $FAKE_STATE_DIR/stubborn-ready once the trap is set: a Stop before that would just kill it.
# Pair it with args that leave out the dev-channel flag.
. "$(dirname "$0")/lib.sh"
trap '' TERM
[ -n "${FAKE_STATE_DIR:-}" ] && : > "$FAKE_STATE_DIR/stubborn-ready"
idle
