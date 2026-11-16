# No dialog. Start 1 is a session whose screen has the CLI's resume error at the start of a line (a transcript that quotes it), and
# which then crashes (exit 1) after $FAKE_CRASH_AFTER seconds (default 3). Later starts idle.
. "$(dirname "$0")/lib.sh"
if [ "${FAKE_START_N:-1}" = 1 ]; then
  printf ' > what did the old run print?\n\nNo session found with ID %s\n\n' "${FAKE_SESSION_ID}"
  input_box
  sleep "${FAKE_CRASH_AFTER:-3}"
  exit 1
fi
input_box
idle
