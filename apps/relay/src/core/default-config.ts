// What the app sees before the Mac has synced its first `config.sync`. Generic on purpose: no personal data.
import type { AgentConfigT } from '@talos-app/protocol'

export const DEFAULT_AGENT_CONFIG: AgentConfigT = {
  version: 1,
  rev: 0,
  agent: { name: 'Talos', voice: 'meridian', voice_persona: '' },
  owner: { display_name: 'You' },
  threads: [
    {
      id: 'general',
      name: 'General',
      icon: '💬',
      kind: 'fixed',
      order: 0,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    },
    {
      id: 'inbox',
      name: 'Inbox',
      icon: '📥',
      kind: 'system',
      order: 1,
      notify: 'all',
      voice_context: 'none',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    },
  ],
  default_thread: 'general',
  timezone: 'UTC',
  quiet_window: null,
  notifications: { master: true, show_thread_names: 'fixed_only' },
  work: {
    label: 'Work systems',
    ask_note: 'Ask your IT team before connecting these.',
    enabled: [],
    retention: 'passthrough',
  },
  voice_notes: { reply_with_voice: 'when_voice', driving_until: null },
  permission_relay: false,
  session_models: ['default', 'opus', 'sonnet', 'haiku'],
  memory_browser: true,
}
