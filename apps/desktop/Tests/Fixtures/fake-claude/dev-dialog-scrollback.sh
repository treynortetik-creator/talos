# The warning's words in the conversation ABOVE a frame rule (its title, its Channels line), and below the rule, live, a select of another
# kind whose rows read like the warning's options. The live region is not the warning, so nothing may be pressed: the key guard decides
# from below the last rule only. An Enter would end this fake with the notice (the warning's words gone from the screen).
. "$(dirname "$0")/lib.sh"
frame " An earlier run printed this:
 WARNING: Loading development channels
 Channels: $CHANNELS
────────────────────────────────────────────────
 Pick how this session pays for its next turn

 ❯ 1. I am using this for local development
   2. Exit

 Enter to confirm · Esc to cancel"
wait_enter; print_notice; idle
