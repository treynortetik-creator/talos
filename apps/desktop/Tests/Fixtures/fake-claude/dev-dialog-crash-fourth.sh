# The dev-channel dialog, Enter, the notice, idle; start number $FAKE_CRASH_START (default 4) exits 1 after $FAKE_CRASH_AFTER seconds (default 2)
# instead. Every other start idles. For "three owner resets, then one real crash".
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
if [ "${FAKE_START_N:-1}" = "${FAKE_CRASH_START:-4}" ]; then sleep "${FAKE_CRASH_AFTER:-2}"; exit 1; fi
idle
