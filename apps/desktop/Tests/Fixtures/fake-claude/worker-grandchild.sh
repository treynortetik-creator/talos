# A thread session (worker.sh) that leaves a grandchild in its group: a sleep that ignores SIGTERM and SIGHUP (FAKE_GRANDCHILD_TRAP names others), its pid in $FAKE_GRANDCHILD_PID_FILE.
bash -c 'trap "" ${FAKE_GRANDCHILD_TRAP:-TERM HUP}; exec /bin/sleep "${FAKE_MAX_LIFETIME:-120}"' </dev/null >/dev/null 2>&1 &
echo $! > "$FAKE_GRANDCHILD_PID_FILE"
. "$(dirname "$0")/worker.sh"
