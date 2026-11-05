# With --resume: the CLI's resume failure. With --session-id (a new conversation): the normal dialog.
. "$(dirname "$0")/lib.sh"
for a in "$@"; do
  if [ "$a" = "--resume" ]; then
    echo "No session found with ID ${FAKE_SESSION_ID}"
    sleep 0.3
    exit 1
  fi
done
show_dialog; wait_enter; print_notice; idle
