// The 12 tools spec 4.4 says a bridge lists, by name. Written out here on purpose: the contract is what the spec asks for,
// so it must not read the answer from the bridge under test (the bridge keeps its own table, apps/bridge/src/tools/table.ts,
// and a bridge test pins that its core group equals this list).
export const SPEC_CORE_TOOLS = [
  'reply',
  'attach',
  'card',
  'card_result',
  'set_status',
  'voice_progress',
  'list_threads',
  'create_thread',
  'archive_thread',
  'read_thread',
  'inbox_triage',
  'inbox_raw',
] as const
