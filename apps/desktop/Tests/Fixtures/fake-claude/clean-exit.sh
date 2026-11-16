# No dialog (pair it with args that leave out the dev-channel flag). The first $FAKE_CLEAN_EXITS starts (default: every start) end by
# themselves with exit code 0 after $FAKE_EXIT_AFTER seconds (default 0.4), as an `/exit` does; later starts idle.
. "$(dirname "$0")/lib.sh"
input_box
if [ "${FAKE_START_N:-1}" -le "${FAKE_CLEAN_EXITS:-1000000}" ]; then sleep "${FAKE_EXIT_AFTER:-0.4}"; exit 0; fi
idle
