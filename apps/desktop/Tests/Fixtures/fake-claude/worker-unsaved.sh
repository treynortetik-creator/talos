# A thread session under Claude Code's own rules about a session id (lib.sh `session_id_rules`): nothing is saved at the start, so a
# session nobody typed in has no conversation file. FAKE_SAVE_AT_START=1 saves one (the owner typed something). Then it is worker.sh.
# FAKE_REFUSE_SESSION_ID=<n> needs FAKE_STATE_DIR (the start counter).
. "$(dirname "$0")/lib.sh"
session_id_rules "$@"
[ -n "${FAKE_SAVE_AT_START:-}" ] && save_transcript "$FAKE_SESSION_ID"
exec /bin/bash "$(dirname "$0")/worker.sh" "$@"
