# Log lines that QUOTE the warning (its title, its Channels line, even its first option inside a sentence) on a screen with no dialog on it:
# the start has not asked anything. Nothing may be pressed. An Enter would end this fake with the notice.
. "$(dirname "$0")/lib.sh"
frame " An earlier run printed this:
 WARNING: Loading development channels
 Channels: $CHANNELS
 and the choices were \"❯ 1. I am using this for local development\" and \"2. Exit\"

 > "
wait_enter; print_notice; idle
