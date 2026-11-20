// Settings > Bug reports says what the relay really does with a report: its own answer (GET /api/bug-reports/destination)
// wins over the synced config, which cannot know the relay's environment (the signing secret, a team inbox set at deploy).
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BugReportsSection } from '../../src/features/settings/BugReportsSection.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => cleanup())

function show(dest: unknown, host?: string) {
  const client = setup()
  if (host)
    client.store.setState((s) => ({ ...s, config: { ...(s.config as object), bug_webhook_host: host } as never }))
  if (dest instanceof Error) vi.spyOn(client.bugs, 'destination').mockRejectedValue(dest)
  else if (dest instanceof Promise) vi.spyOn(client.bugs, 'destination').mockReturnValue(dest as never)
  else vi.spyOn(client.bugs, 'destination').mockResolvedValue(dest as never)
  renderWith(<BugReportsSection readOnly={false} />, client)
  return () => screen.getByTestId('bug-webhook-state').textContent
}

describe('Settings > Bug reports, the state line', () => {
  it('claims nothing while the relay is being asked', () => {
    const state = show(new Promise(() => undefined))
    expect(state()).toBe('Checking where reports go…')
  })
  it('the Talos team, when the relay was deployed with the team inbox and no address of her own is set', async () => {
    const state = show({ to: 'team' })
    await waitFor(() => expect(state()).toMatch(/^New reports go to the Talos team, with the screenshot\./))
  })
  it('off, naming the saved address, when the relay does not send to it (no secret)', async () => {
    const state = show({ to: 'relay' }, 'hooks.example.com')
    await waitFor(() =>
      expect(state()).toMatch(/^Off: an address \(hooks\.example\.com\) is saved, but your Talos server does not send/),
    )
  })
  it('the host the relay sends to', async () => {
    const state = show({ to: 'webhook', host: 'hooks.example.com' }, 'hooks.example.com')
    await waitFor(() => expect(state()).toBe('New reports go to hooks.example.com.'))
  })
  it('an older relay that cannot say: what the synced config says, as before', async () => {
    const state = show(new Error('404'), 'hooks.example.com')
    await waitFor(() => expect(state()).toBe('New reports go to hooks.example.com.'))
  })
})
