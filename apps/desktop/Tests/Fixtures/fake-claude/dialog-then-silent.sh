# The normal dev-channel dialog and the Enter, but then plain output: the notice never comes (its wording drifted).
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; printf '\033[2J\033[H working…\n'; idle
