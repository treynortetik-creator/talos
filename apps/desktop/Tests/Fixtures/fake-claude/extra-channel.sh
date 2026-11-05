# Start 1 confirms with the approved channel, crashes; the restart's dialog lists a lookalike too.
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog "server:talos-app, server:talos-app-evil"; wait_enter; print_notice; idle'
