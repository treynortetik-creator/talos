# crash-after.sh N: dialog → Enter → notice; on the first $FAKE_CRASHES starts (default 1) spawn a bridge-looking child
# in our own group, write bridge.pid at it, then exit 1 after N seconds. Later starts idle after the notice.
. "$(dirname "$0")/lib.sh"
N="${FAKE_CRASH_SECONDS:-1}"
show_dialog; wait_enter; print_notice
if [ "${FAKE_START_N:-1}" -le "${FAKE_CRASHES:-1}" ]; then
  spawn_holder
  crash_wait "$N"
  exit 1
fi
idle
