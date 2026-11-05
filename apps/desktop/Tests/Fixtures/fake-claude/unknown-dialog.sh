# A prompt Talos does not recognise (a changed CLI wording), the test-played Enter, then the registration notice.
. "$(dirname "$0")/lib.sh"
printf '\033[2J\033[H Some new question the CLI never asked before\n\n  Press Enter to go on\n'
wait_enter; print_notice; idle
