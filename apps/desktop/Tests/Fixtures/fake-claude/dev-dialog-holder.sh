# The dev dialog, Enter, the notice; then a bridge-looking child in our own group with bridge.pid and bot.pid at it.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice; spawn_holder; idle
