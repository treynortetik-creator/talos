# The dev-channel dialog, wait for Enter, a plain screen (the start stalls), wait for Enter, the folder-trust dialog, wait for Enter,
# the dev-channel dialog again, wait for Enter, and a different plain screen with no registration notice.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter
frame ' Setting up the workspace'
wait_enter
printf '\033[2J\033[H'
printf ' Accessing workspace:\n\n /tmp/agent\n\n Quick safety check: Is this a project you created or one you trust?\n\n'
printf ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n'
wait_enter
show_dialog; wait_enter
frame ' Still setting up the workspace'
idle
