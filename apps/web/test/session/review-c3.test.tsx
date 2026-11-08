// Regression tests for the Claude Code session controls in the web app; each test names the bug it guards.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionTrigger } from '../../src/features/session/SessionTrigger.tsx'
import { createSessionController } from '../../src/features/session/store.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe('R1: the session sheet survives a relay that echoes the bridge features (Schedules S2)', () => {
  // main's bridge already says hello with features ['schedules/1'] (bridge.ts); feat/schedules-s2's relay echoes them in
  // presence.features. C3's bridge never adds 'session/1', so useSessionSupported() turns false and the sheet vanishes.
  // The fix is in the bridge (it now advertises 'session/1'; test/cc-c3.test.ts pins that), so the app keeps its gate for
  // old bridges and this case is the one a fixed bridge produces.
  it.each([[['schedules/1', 'session/1']]])('presence.features %j still gets the session button', async (features) => {
    const client = setup()
    client.store.setState((s) => ({ presence: { ...s.presence, features } }))
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter>
            <SessionTrigger threadId="general" />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
    await wait()
    // The reading is on screen, so the button is named by it (not by a fixed word that is not in it).
    const button = screen.getByTestId('session-trigger')
    const chip = screen.getByTestId('session-chip').textContent?.replace(/\s+/g, '') ?? ''
    expect(chip).toContain('wk60%')
    expect(
      screen.getByRole('button', { name: (name) => name.replace(/\s+/g, '').includes(chip) }),
      'accessible name contains the visible text',
    ).toBe(button)
    expect(button.hasAttribute('aria-label')).toBe(false)
  })

  it('with no reading yet the button is still named, by the word it shows', () => {
    const client = setup()
    client.store.setState((s) => ({ presence: { ...s.presence, features: ['session/1'] } }))
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter>
            <SessionTrigger threadId="general" />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
    // Rendered before any session state arrives: there is no chip, so only the fallback label can name it.
    expect(screen.queryByTestId('session-chip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Session' })).toBe(screen.getByTestId('session-trigger'))
  })
})

describe('R4: a result that lands after the phone gave up still shows', () => {
  // Phone 20 s < bridge 45 s backstop < a real compaction. A compact that finishes at 30 s says "The Mac did not answer"
  // forever, and the real "Compacted." is dropped by settle().
  it('a late ok result replaces "The Mac did not answer"', async () => {
    const client = setup()
    const ctl = createSessionController(client, { timeoutMs: 40 })
    ctl.start()
    await wait()
    client.session.mute(true)
    const o = await ctl.compact('general')
    expect(o).toMatchObject({ kind: 'error', text: 'The Mac did not answer' })
    const sent = client.sent.filter((f) => f.type === 'session.control').at(-1) as { control_id: string }
    client.emit('session.control.result', {
      control_id: sent.control_id,
      ok: true,
      text: 'Compacted.',
      at: new Date().toISOString(),
    })
    await wait()
    expect(ctl.store.getState().last).toMatchObject({ kind: 'ok', text: 'Compacted.' })
  })
})
