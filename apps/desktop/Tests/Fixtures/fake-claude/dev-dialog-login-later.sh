# The dev-channel dialog, Enter, a resumed conversation (no notice); then each further Enter from the test: a login-expired dialog over it,
# then the conversation again.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_resumed
wait_enter; frame ' Not logged in · Please run /login'
wait_enter; print_resumed
idle
