// Fourth pass on PR #92 (WP-I5): the Apple payload uses fixed strings only (title "Talos", "General", "Inbox").
import { buildPushPayload, type PushIntent } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { appleConfig, forApple } from '../../src/core/push.ts'

const NAMED = 'Severance Desk'
const cfg = {
  ...DEFAULT_AGENT_CONFIG,
  agent: { ...DEFAULT_AGENT_CONFIG.agent, name: NAMED },
  threads: DEFAULT_AGENT_CONFIG.threads.map((t) => (t.id === 'general' ? { ...t, name: 'Bob talks' } : t)),
}
const apple = (intent: PushIntent) => forApple(buildPushPayload(intent, appleConfig(cfg)), () => 'ref')

describe('the Apple payload carries fixed strings only', () => {
  it.each(['reply', 'session_stopped', 'mod_quiet', 'mac_back', 'needs_you'] as const)(
    '%s: title is Talos and the agent name never appears',
    (template) => {
      const p = apple({ template, thread_id: 'general' })
      expect(p.notification.title).toBe('Talos')
      expect(JSON.stringify(p)).not.toMatch(/severance|bob/i)
    },
  )

  it('General and Inbox are the fixed words', () => {
    expect(apple({ template: 'reply', thread_id: 'general' }).notification.body).toBe('New reply in General')
    expect(apple({ template: 'reply', thread_id: 'inbox' }).notification.body).toBe('New reply in Inbox')
  })
})
