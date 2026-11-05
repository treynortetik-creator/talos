# Start 1 confirms normally, crashes. The restart's dialog first shows with the title twice (what a screen read mid-paint can look
# like): the supervisor refuses it as ambiguous. After one Enter from the test the dialog has the cursor on "Exit": a clear
# reading, refused for its own reason. Nothing here takes the supervisor's Enter into account; it presses none.
. "$(dirname "$0")/lib.sh"
twice() {
  frame " WARNING: Loading development channels
 WARNING: Loading development channels

 Channels: $CHANNELS

   ❯ 1. I am using this for local development
     2. Exit"
}
restart() { twice; wait_enter; show_dialog "" 2; wait_enter; print_notice; idle; }
crash_first_then restart
