# The dev-channel dialog, wait for Enter, the folder-trust dialog, wait for Enter, a blank screen, wait for Enter, then the
# folder-trust dialog again (not the dev-channel one) and no registration notice.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter
trust() {
  printf '\033[2J\033[H'
  printf ' Accessing workspace:\n\n /tmp/agent\n\n Quick safety check: Is this a project you created or one you trust?\n\n'
  printf ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n'
}
trust; wait_enter
frame ""
wait_enter
trust
idle
