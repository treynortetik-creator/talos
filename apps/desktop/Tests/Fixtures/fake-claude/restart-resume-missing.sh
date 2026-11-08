# Start 1 confirms normally, crashes; the restart (--resume of that start's id) is told the conversation is gone and exits at once
# (FAKE_RESUME_EXIT_NOW: before the host can read a pid; FAKE_RESUME_LINE: the wording).
. "$(dirname "$0")/lib.sh"
resume_gone() {
  echo "${FAKE_RESUME_LINE:-No session found with ID} ${FAKE_SESSION_ID}"
  [ -n "${FAKE_RESUME_EXIT_NOW:-}" ] || sleep 0.3
  exit 1
}
crash_first_then resume_gone
