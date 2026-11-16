# The dev-channel dialog, Enter, the notice; the first $FAKE_CLEAN_EXITS starts (default 1) then end by themselves with exit code 0
# after $FAKE_EXIT_AFTER seconds (default 1). Later starts idle.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
if [ "${FAKE_START_N:-1}" -le "${FAKE_CLEAN_EXITS:-1}" ]; then sleep "${FAKE_EXIT_AFTER:-1}"; exit 0; fi
idle
