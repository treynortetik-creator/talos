# With --resume: the CLI's resume failure. With --session-id (a new conversation): the normal dialog.
. "$(dirname "$0")/lib.sh"
for a in "$@"; do
  if [ "$a" = "--resume" ]; then
    echo "${FAKE_RESUME_LINE:-No session found with ID} ${FAKE_SESSION_ID}"
    [ -n "${FAKE_RESUME_EXIT_NOW:-}" ] || sleep 0.3  # FAKE_RESUME_EXIT_NOW: exit before the host can read a pid
    exit 1
  fi
done
show_dialog; wait_enter; print_notice; idle
