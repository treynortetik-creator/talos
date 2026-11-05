# The dev-channel dialog, wait for Enter, a plain screen that shows nothing Talos recognises (the start stalls), wait for Enter,
# then the dev-channel dialog again and no registration notice.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter
frame ' Setting up the workspace'
wait_enter
show_dialog
idle
