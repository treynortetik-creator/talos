import { z } from 'zod'

export const ErrorCode = z.enum([
  'bad_frame',
  'unauthorized',
  'stepup_required',
  'stepup_invalid',
  'card_not_pending',
  'card_expired',
  'card_hash_mismatch',
  'card_edit_forbidden',
  'config_conflict',
  'config_field_forbidden',
  'integration_disabled',
  'device_not_pinned',
  'sig_invalid',
  'mac_offline',
  'rate_limited',
  'too_large',
  'internal',
  // Schedules (docs/SCHEDULES.md S2.2)
  'scheduler_unavailable',
  'schedule_invalid',
  'schedule_conflict',
  'schedule_not_found',
  'schedule_read_only',
  'already_running',
  'headless_blocked',
  'held',
  'not_owner',
  'stale',
  // Claude Code integration (docs/CLAUDE-CODE.md C2.5, C3.3, C4.2, C4.4)
  'control_stale',
  'command_changed',
  'command_not_allowed',
  'args_invalid',
  'capability_missing',
  'turn_mismatch',
  'stopped_at_mac',
  'model_not_allowed',
  'model_switch_denied',
  'model_switch_pending',
  'effort_change_pending',
  'permission_closed',
  'permission_hidden',
  // Subagent panel (docs/SUBAGENTS.md): an agent_stop for a row that is gone, ended or not stoppable
  'agent_not_found',
  // v2 features (docs/V2-FEATURES.md V1.3)
  'search_unavailable', // no FTS5, or the index is empty and building, or the 1.5 s budget ran out
  'bad_query',
  'memory_off',
  'memory_not_found', // also for excluded, private and denylisted paths, with no distinction
  'share_token_invalid',
  'share_disabled',
  // Option C (docs/OPTION-C.md 9.1)
  'worker_unavailable', // the thread's own session can't take this right now
  'worker_cap', // every slot is busy
  'usage_governor', // plan limits are near: no new thread-session starts
  'worker_folder_claimed', // another session works in that folder
  'needs_mac', // a dialog at the Mac needs the owner
  'thread_session_refused', // a config.patch the Mac refused for an Option C reason (front-door thread, bad folder)
])
export type ErrorCodeT = z.infer<typeof ErrorCode>

/** WebSocket close codes (3.4). */
export const WS_CLOSE = {
  BAD_FRAME: 4400,
  UNAUTHORIZED: 4401,
  BAD_ORIGIN: 4403,
  HANDSHAKE_TIMEOUT: 4408,
  SUPERSEDED: 4409,
  FRAME_TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
} as const

/** Max frame size before and after authentication (3.4). */
export const MAX_FRAME_BYTES_UNAUTH = 64 * 1024
export const MAX_FRAME_BYTES = 256 * 1024
