# Start 1 confirms normally, crashes; the restart takes the Enter but the warning stays on screen and the notice never comes (a resumed session
# that goes on to its conversation is `dev-dialog-keys.sh` with FAKE_RESUMED=1: that one is running, see NoNoticeRunningTests).
. "$(dirname "$0")/lib.sh"
crash_first_then eval 'show_dialog; wait_enter; idle'
