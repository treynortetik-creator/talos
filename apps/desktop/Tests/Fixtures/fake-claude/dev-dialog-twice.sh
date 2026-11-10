# The dev-channel dialog from the first start; after one Enter it is drawn again (a second appearance in the same start), then the notice.
. "$(dirname "$0")/lib.sh"
show_dialog; wait_enter; show_dialog; wait_enter; print_notice; idle
