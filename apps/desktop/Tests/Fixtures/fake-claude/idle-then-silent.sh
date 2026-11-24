# Start 1 confirms normally (the dev-channel dialog, then the registration notice) and just runs. A later start (the restart a request
# began) shows plain output Talos does not recognise and never finishes starting.
. "$(dirname "$0")/lib.sh"
if [ "${FAKE_START_N:-1}" = 1 ]; then first_start_ok; idle; fi
printf '\033[2J\033[H working…\n'; idle
