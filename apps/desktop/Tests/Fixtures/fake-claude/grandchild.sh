# Main's session (dev-channel dialog, the test's Enter, the notice) that leaves a grandchild in its group: a sleep that ignores
# SIGTERM, its pid in $FAKE_GRANDCHILD_PID_FILE.
. "$(dirname "$0")/lib.sh"
bash -c 'trap "" ${FAKE_GRANDCHILD_TRAP:-TERM HUP}; exec /bin/sleep "${FAKE_MAX_LIFETIME:-120}"' </dev/null >/dev/null 2>&1 &
echo $! > "$FAKE_GRANDCHILD_PID_FILE"
first_start_ok; idle
