# Start 1 confirms normally, crashes; the restart prints plain output: no dialog and no registration notice.
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'printf "\033[2J\033[H working…\n"; idle'
