// Owner-approved polish calls (2026-10-31): row ages, FAB ring, memory header, Connection/Health split, Health error
// state, search hint, inbox avatars, one "Driving mode" label.
import { PROTOCOL_VERSION } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrivingRow } from '../../src/features/drive/DrivingRow.tsx'
import { HealthScreen } from '../../src/features/health/HealthScreen.tsx'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { shortAge } from '../../src/lib/format.ts'
import { makeCard, makeItem, renderWith, setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const NOW = Date.parse('2026-10-28T16:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const H = 60 * MIN
const D = 24 * H

describe('shortAge', () => {
  it('writes now, 4m, 3h, 3d with no space and no "ago"', () => {
    expect(shortAge(ago(10_000), NOW)).toBe('now')
    expect(shortAge(ago(4 * MIN), NOW)).toBe('4m')
    expect(shortAge(ago(3 * H), NOW)).toBe('3h')
    expect(shortAge(ago(3 * D), NOW)).toBe('3d')
    expect(shortAge(null, NOW)).toBe('')
    expect(shortAge('not a date', NOW)).toBe('')
  })
})

describe('row times', () => {
  it('Inbox rows read "3d" in tabular numbers', () => {
    const client = setup({ inbox: [makeItem({ title: 'Old one', ts: ago(3 * D) })] })
    renderWith(<InboxScreen />, client, '/t/inbox')
    const t = screen.getByText('3d')
    expect(t.className).toContain('tabular-nums')
  })

  it('Home rows read "3d" in tabular numbers', () => {
    const client = setup({ cards: [makeCard({ title: 'Old card', created_at: ago(3 * D), expires_at: ago(-2 * D) })] })
    renderWith(<HomeScreen />, client, '/')
    const t = screen.getAllByText('3d')[0] as HTMLElement
    expect(t.className).toContain('tabular-nums')
  })

  it('Threads rows read "3d" in tabular numbers', () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      messages: {
        ...s.messages,
        general: [
          {
            id: 'm_0000000000000000000000000A',
            thread_id: 'general',
            author: 'agent',
            kind: 'text',
            text: 'hello',
            format: 'markdown',
            attachments: [],
            via: 'app',
            created_at: ago(3 * D),
          } as never,
        ],
      },
    }))
    renderWith(<ThreadList />, client, '/threads')
    const row = screen.getByTestId('thread-row-general')
    const t = within(row).getByText('3d')
    expect(t.className).toContain('tabular-nums')
  })
})

describe('Ask button', () => {
  it('has no black ring', () => {
    const client = setup({ cards: [makeCard({ title: 'Something' })] })
    renderWith(<HomeScreen />, client, '/')
    const fab = screen.getByRole('button', { name: /^Ask / })
    expect(fab.className).not.toContain('talos-black')
  })
})

describe('Connection and Health', () => {
  it('Health carries the old Connection lines (Mac, Server, Waiting to deliver) and still lists Protocol and App', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    renderWith(<HealthScreen />, setup(), '/settings/health')
    const c = screen.getByTestId('connection-block')
    expect(within(c).getByText('Waiting to deliver')).toBeTruthy()
    expect(within(c).getByTestId('mac-status').textContent).toMatch(/Mac online/)
    expect(within(c).getByText('Server')).toBeTruthy()
    expect(screen.queryByText('Relay buffer')).toBeNull()
  })

  it('Health lists Protocol and App', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    renderWith(<HealthScreen />, setup(), '/settings/health')
    const v = screen.getByTestId('health-versions')
    expect(within(v).getByText('Protocol')).toBeTruthy()
    expect(within(v).getByText(`v${PROTOCOL_VERSION}`)).toBeTruthy()
    expect(within(v).getByText('App')).toBeTruthy()
  })

  it('Health error is a mascot, a sentence and Retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    renderWith(<HealthScreen />, setup(), '/settings/health')
    const err = await screen.findByTestId('health-error')
    expect(within(err).getByRole('alert').textContent).toBe("Couldn't load health.")
    expect(err.querySelector('[data-mascot], video, img')).not.toBeNull()
    expect(within(err).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('Health after a good load', () => {
  it('a failed poll keeps the rows and shows a compact line with Retry, not the mascot block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => statusOf(), text: async () => '' })
      .mockRejectedValue(new Error('down'))
    vi.stubGlobal('fetch', fetchMock)
    renderWith(<HealthScreen />, setup(), '/settings/health')
    await waitFor(() => expect(document.querySelectorAll('[data-testid^="health-row-"]').length).toBeGreaterThan(0))
    document.dispatchEvent(new Event('visibilitychange'))
    const stale = await screen.findByTestId('health-stale')
    expect(within(stale).getByRole('alert').textContent).toBe("Couldn't load health.")
    expect(within(stale).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByTestId('health-error')).toBeNull()
    expect(document.querySelectorAll('[data-testid^="health-row-"]').length).toBeGreaterThan(0)
  })
})

describe('Driving mode', () => {
  it('shows the words "Driving mode" once', () => {
    render(
      <ClientProvider client={setup()}>
        <MemoryRouter>
          <DrivingRow readOnly={false} />
        </MemoryRouter>
      </ClientProvider>,
    )
    const row = screen.getByTestId('driving-row')
    expect(within(row).getAllByText('Driving mode')).toHaveLength(1)
    expect(row.querySelector('legend')).toBeNull()
    expect(within(row).getByRole('switch', { name: 'Driving mode' })).toBeTruthy()
  })
})

describe('Inbox avatars', () => {
  it('uses the integration icon, and initials when there is no icon for the source', async () => {
    const client = setup({
      inbox: [makeItem({ title: 'A PR', source: 'github' }), makeItem({ title: 'A mystery', source: 'generic' })],
    })
    // the catalog says github has a drawable icon; "generic" is given an icon key this app cannot draw
    vi.spyOn(client.api, 'catalog').mockResolvedValue([
      { id: 'github', icon: 'github' },
      { id: 'generic', icon: 'unknown-key' },
    ] as never)
    renderWith(<InboxScreen />, client, '/t/inbox')
    await waitFor(() => expect(document.querySelectorAll('[data-source-avatar="icon"]')).toHaveLength(1))
    const initials = document.querySelector('[data-source-avatar="initials"]')
    expect(initials?.textContent).toBe('ge')
  })

  it('falls back to initials while the catalog has not loaded', () => {
    const client = setup({ inbox: [makeItem({ title: 'A PR', source: 'github' })] })
    vi.spyOn(client.api, 'catalog').mockReturnValue(new Promise(() => {}))
    renderWith(<InboxScreen />, client, '/t/inbox')
    expect(document.querySelector('[data-source-avatar="initials"]')?.textContent).toBe('gi')
  })
})

describe('Inbox avatars in a thread timeline', () => {
  it('an event row rendered through MessageView draws the integration icon', async () => {
    const item = makeItem({ title: 'A PR', source: 'github', thread: 'general' })
    const client = setup({ inbox: [item] })
    vi.spyOn(client.api, 'catalog').mockResolvedValue([{ id: 'github', icon: 'github' }] as never)
    const m = {
      id: 'm_0000000000000000000000000B',
      thread_id: 'general',
      author: 'hook',
      kind: 'event',
      event_id: item.id,
      text: 'A PR',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: ago(MIN),
    } as never
    renderWith(
      <MessageView message={m} cards={[]} inbox={[item]} onOpenImage={() => {}} onOpenItem={() => {}} />,
      client,
      '/t/general',
    )
    await waitFor(() => expect(document.querySelector('[data-source-avatar="icon"]')).not.toBeNull())
  })
})

describe('Memory row ages', () => {
  it('shortAge is what the memory list calls', async () => {
    const src = await import('../../src/features/memory/index.tsx?raw')
    expect(src.default).toContain('shortAge(e.mtime)')
    expect(src.default).not.toContain('relativeTime(e.mtime)')
  })
})
