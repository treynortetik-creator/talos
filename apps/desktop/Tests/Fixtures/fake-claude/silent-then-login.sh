# A prompt Talos does not recognise and never finishes starting; the test-played Enter shows a login-expired dialog, the next one
# goes back to a screen Talos does not recognise.
. "$(dirname "$0")/lib.sh"
frame ' Some new question the CLI never asked before'
wait_enter; frame ' Not logged in · Please run /login'
wait_enter; frame ' Still working on it'
idle
