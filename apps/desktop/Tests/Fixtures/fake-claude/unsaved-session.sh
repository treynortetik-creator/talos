# Claude Code's rules about a session id, as the real CLI (2.1.322) has them:
#   --resume <id> with no saved conversation, or with a file that holds only meta and slash-command lines, prints
#     "No conversation found with session ID: <id>" and exits 1;
#   --session-id <id> with a file for that id in this folder prints "Error: Session ID <id> is already in use." and exits 1.
# Otherwise: no dialog, the input box. Start 1 crashes (exit 1) when the test says so (FAKE_CRASH_ON_FILE) or after
# FAKE_CRASH_AFTER seconds; later starts idle. Nothing is saved unless FAKE_SAVE_AT_START=1 (the owner typed something).
# FAKE_REFUSE_SESSION_ID=<n>: from start n on, every --session-id is refused as in use and --resume is accepted (a conversation
# saved where the supervisor did not look). FAKE_ALSO_CRASH="3 5": those starts crash like start 1. FAKE_ERROR_HOLD: seconds an error stays up before the exit (default 0.3).
. "$(dirname "$0")/lib.sh"
session_id_rules "$@"
[ -n "${FAKE_SAVE_AT_START:-}" ] && save_transcript "$FAKE_SESSION_ID"
input_box
case " 1 ${FAKE_ALSO_CRASH:-} " in *" ${FAKE_START_N:-1} "*) crash_wait "${FAKE_CRASH_AFTER:-1}"; exit 1 ;; esac
idle
