# The dev-channel dialog from the first start, with the title printed twice (what a screen read mid-paint can look like).
. "$(dirname "$0")/lib.sh"
frame " WARNING: Loading development channels
 WARNING: Loading development channels

 Channels: $CHANNELS

   ❯ 1. I am using this for local development
     2. Exit"
wait_enter; print_notice; idle
