# The dev-channel dialog, wait for Enter, a plain screen (the start stalls), wait for Enter, the dev-channel dialog again, wait for
# Enter, and a different plain screen with no registration notice.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter
frame ' Setting up the workspace'
wait_enter
show_dialog; wait_enter
frame ' Still setting up the workspace'
idle
