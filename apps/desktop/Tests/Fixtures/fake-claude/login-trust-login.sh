# Confirms normally; each further Enter from the test replaces the screen by another dialog without a blank screen in between:
# login expired, folder trust, login expired again.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; print_notice
wait_enter; frame ' Not logged in · Please run /login'
wait_enter; frame ' Do you trust the files in this folder?

 ❯ 1. Yes, I trust this folder
   2. No, exit'
wait_enter; frame ' Not logged in · Please run /login'
idle
