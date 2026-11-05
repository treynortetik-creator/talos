import { describe, expect, it } from 'vitest'
import { scriptText, templateContext } from '../../src/features/integrations/adapters.ts'

const base = {
  id: 'cn_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'Mail',
  thread: 'inbox',
  status: 'active',
  filters: {},
  created_at: '2026-01-01T00:00:00.000Z',
  last_event_at: null,
  kept_24h: 0,
  received_24h: 0,
  hook_url: 'https://relay.example.com/hook/gmail/cn_01HZZZZZZZZZZZZZZZZZZZZZZZ',
}

describe('wizard adapters', () => {
  it('renders the Gmail, Calendar and Forward scripts from hook_url and claim_code', () => {
    const ctx = templateContext({ ...base, integration: 'gmail', claim_code: 'claim_abcdefgh' } as never)
    for (const id of ['gmail', 'gmail_work', 'gcal', 'forward']) {
      const text = scriptText(id, ctx)
      expect(text, id).toContain('https://relay.example.com/hook/gmail/')
      expect(text, id).not.toContain('{{')
    }
  })

  it('has no script without a claim code, or for an unknown template', () => {
    expect(scriptText('gmail', templateContext({ ...base, integration: 'gmail' } as never))).toBeNull()
    const ctx = templateContext({ ...base, integration: 'gmail', claim_code: 'claim_abcdefgh' } as never)
    expect(scriptText('nope', ctx)).toBeNull()
  })

  it('builds the Slack manifest link only for Slack', () => {
    const slack = templateContext({ ...base, integration: 'slack' } as never)
    expect(slack.MANIFEST_URL).toMatch(/^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/)
    expect(templateContext({ ...base, integration: 'gmail' } as never).MANIFEST_URL).toBeUndefined()
  })
})
