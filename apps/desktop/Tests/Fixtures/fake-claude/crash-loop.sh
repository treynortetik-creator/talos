# Start 1 confirms normally and crashes; every later start crashes after 0.5 s without a dialog.
. "$(dirname "$0")/lib.sh"
crash_first_then sh -c 'echo crashing; sleep 0.5; exit 1'
