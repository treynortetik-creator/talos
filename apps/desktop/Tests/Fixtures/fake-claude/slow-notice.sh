# slow-notice.sh: crash-after.sh, except that a restart takes FAKE_NOTICE_DELAY seconds to redraw after its Enter (a busy Mac).
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter
[ "${FAKE_START_N:-1}" -gt 1 ] && sleep "${FAKE_NOTICE_DELAY:-1}"
print_notice
if [ "${FAKE_START_N:-1}" -le 1 ]; then
  spawn_holder
  crash_wait "${FAKE_CRASH_SECONDS:-1}"
  exit 1
fi
idle
