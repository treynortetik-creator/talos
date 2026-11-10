import { type CardT, composeDialogCard } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHome } from '../../src/features/home/groups.ts'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { makeCard, makeItem, renderWith, setup } from '../cards/helpers.tsx'

afterEach(() => vi.useRealTimers())

const NOW = Date.parse('2026-10-28T16:00:00.000Z')
const status = (thread_id: string, state: 'idle' | 'working' | 'needs_you' | 'queued') => ({
  thread_id,
  state,
  since: '2026-10-28T15:30:00.000Z',
})

function seeded() {
  const pendingSoon = makeCard({ title: 'Reply to venue', expires_at: '2026-10-28T20:00:00.000Z' })
  const pendingLater = makeCard({ title: 'Publish notes', kind: 'publish', expires_at: '2026-10-29T20:00:00.000Z' })
  const doneToday = makeCard({
    title: 'Sent invoice',
    state: 'done',
    resolution: { action: 'primary', at: '2026-10-28T09:00:00.000Z', edited: false, payload_hash: 'sha256:x' },
    result: { ok: true, text: 'Sent', at: '2026-10-28T09:00:00.000Z' },
  })
  const doneYesterday = makeCard({
    title: 'Old thing',
    state: 'done',
    resolution: { action: 'primary', at: '2026-10-27T09:00:00.000Z', edited: false, payload_hash: 'sha256:x' },
    result: { ok: true, text: 'Sent', at: '2026-10-27T09:00:00.000Z' },
  })
  const client = setup({ cards: [pendingLater, pendingSoon, doneToday, doneYesterday] })
  client.store.setState((s) => ({
    ...s,
    threads: [
      ...s.threads,
      {
        id: 'research',
        name: 'Research',
        kind: 'fixed' as const,
        order: 2,
        notify: 'all' as const,
        voice_context: 'recent' as const,
        archived: false,
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ],
    statuses: { research: status('research', 'working') },
  }))
  return { client, pendingSoon, pendingLater }
}

describe('buildHome', () => {
  it('lists a development-channels dialog card under Needs you, and counts it', () => {
    const d = composeDialogCard({
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4AA',
      dialog: {
        id: 'Dv5Qm8ZtRx3Cw9PkNa2HdB',
        kind: 'dev_channels',
        subject: 'server:talos-app',
        options: ['I am using this for local development', 'Exit'],
        cursor: 0,
        seen_at: new Date(NOW).toISOString(),
        expires_at: new Date(NOW + 900_000).toISOString(),
      },
      thread_id: 'general',
      thread_name: 'General',
      now: NOW,
    }) as CardT
    const client = setup({ cards: [d] })
    const m = buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    expect(m.groups.find((g) => g.id === 'needs_you')?.rows.map((r) => r.id)).toEqual([d.id])
    expect(m.needsYouCount).toBe(1)
  })

  it('orders groups Needs you → Ready for review → Working → Done today, with counts', () => {
    const { client } = seeded()
    client.store.setState((s) => ({ ...s, unread: { general: 3 } }))
    const s = client.store.getState()
    const m = buildHome(s, { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    expect(m.groups.map((g) => [g.id, g.rows.length])).toEqual([
      ['needs_you', 2],
      ['ready', 0], // general has a pending card, so it is not "ready"
      ['working', 1],
      ['done_today', 1],
    ])
    expect(m.needsYouCount).toBe(2)
  })

  it('puts the card that expires first on top', () => {
    const { client, pendingSoon } = seeded()
    const m = buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    expect(m.groups[0]?.rows[0]?.id).toBe(pendingSoon.id)
  })

  it('a thread with unread replies, idle and no pending card is Ready for review', () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: { general: 2 } }))
    const m = buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    expect(m.groups.find((g) => g.id === 'ready')?.rows.map((r) => r.id)).toEqual(['general'])
  })

  it('a snoozed card leaves Needs you, joins Up next, and does not count', () => {
    const { client, pendingSoon } = seeded()
    const m = buildHome(client.store.getState(), {
      nowMs: NOW,
      timeZone: 'UTC',
      localSnoozed: new Map([[pendingSoon.id, NOW + 1000]]),
    })
    expect(m.needsYouCount).toBe(1)
    expect(m.upNext.map((r) => r.id)).toContain(pendingSoon.id)
  })

  it('Up next lists queued threads and snoozed inbox items', () => {
    const client = setup({ inbox: [makeItem({ state: 'snoozed', snooze_until: '2026-10-29T07:00:00.000Z' })] })
    client.store.setState((s) => ({ ...s, statuses: { general: status('general', 'queued') } }))
    const m = buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    expect(m.upNext.map((r) => r.kind).sort()).toEqual(['snoozed', 'thread'])
  })

  it('"today" is the owner timezone day, not UTC', () => {
    const c = makeCard({
      state: 'done',
      resolution: { action: 'primary', at: '2026-10-28T23:30:00.000Z', edited: false, payload_hash: 'sha256:x' },
      result: { ok: true, text: 'ok', at: '2026-10-28T23:30:00.000Z' },
    })
    const client = setup({ cards: [c] })
    const nowTokyo = Date.parse('2026-10-29T00:30:00.000Z') // 09:30 on the 29th in Tokyo; the card is 08:30 on the 29th
    const utc = buildHome(client.store.getState(), { nowMs: nowTokyo, timeZone: 'UTC', localSnoozed: new Map() })
    const tokyo = buildHome(client.store.getState(), {
      nowMs: nowTokyo,
      timeZone: 'Asia/Tokyo',
      localSnoozed: new Map(),
    })
    expect(utc.groups.find((g) => g.id === 'done_today')?.rows).toHaveLength(0)
    expect(tokyo.groups.find((g) => g.id === 'done_today')?.rows).toHaveLength(1)
  })
})

describe('HomeScreen', () => {
  it('renders the groups in order with their counts and the tab count', () => {
    const { client } = seeded()
    renderWith(<HomeScreen />, client)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\s+/g, ' ').trim())
    expect(headings).toEqual(['Needs you 2', 'Working 1', 'Done today 1'])
    expect(screen.getByRole('tab', { name: 'Needs you (2)' })).toBeTruthy()
    expect(screen.getByTestId('count-needs_you').textContent).toBe('2')
  })

  it('rows carry a coloured status word, the reason and a relative time', () => {
    const { client } = seeded()
    renderWith(<HomeScreen />, client)
    const row = screen.getByText('Reply to venue').closest('button') as HTMLElement
    expect(within(row).getByText('Needs you')).toBeTruthy()
    expect(within(row).getByText('events@example.com')).toBeTruthy()
  })

  it('tapping a card row opens /card/:id', async () => {
    const { client, pendingSoon } = seeded()
    renderWith(<HomeScreen />, client)
    await userEvent.click(screen.getByText('Reply to venue'))
    expect(screen.getByTestId('location').textContent).toBe(`/card/${pendingSoon.id}`)
  })

  it('long-press opens Snooze; snoozing moves the card to Up next', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { client } = seeded()
    renderWith(<HomeScreen />, client)
    const row = screen.getByText('Reply to venue').closest('button') as HTMLElement
    fireEvent.pointerDown(row)
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    const menu = screen.getByRole('dialog', { name: /Actions for Reply to venue/ })
    expect(within(menu).queryByRole('button', { name: 'Mark done' })).toBeNull() // a card is decided, not "done"
    fireEvent.click(within(menu).getByRole('button', { name: 'Snooze' }))
    expect(screen.getByRole('tab', { name: 'Needs you (1)' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Up next (1)' })).toBeTruthy()
  })

  it('a short press does not open the menu', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { client } = seeded()
    renderWith(<HomeScreen />, client)
    const row = screen.getByText('Reply to venue').closest('button') as HTMLElement
    fireEvent.pointerDown(row)
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.pointerUp(row)
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Mark done on a ready-for-review thread marks it read', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: { general: 2 } }))
    renderWith(<HomeScreen />, client)
    await userEvent.click(screen.getByRole('button', { name: /More actions for General/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }))
    expect(client.store.getState().unread.general).toBe(0)
  })

  it('Mark done on a snoozed inbox item offers Undo, and Undo brings the snooze back (audit D35)', async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString()
    const item = makeItem({ title: 'Snoozed mail', state: 'snoozed', snooze_until: until })
    const client = setup({ inbox: [item] })
    renderWith(<HomeScreen />, client)
    await userEvent.click(screen.getByRole('tab', { name: /Up next/ }))
    await userEvent.click(screen.getByRole('button', { name: /More actions for Snoozed mail/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }))
    expect(client.store.getState().inbox.find((i) => i.id === item.id)?.state).toBe('done')
    await userEvent.click(within(screen.getByTestId('inbox-undo')).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(client.store.getState().inbox.find((i) => i.id === item.id)?.state).toBe('snoozed'))
    expect(client.store.getState().inbox.find((i) => i.id === item.id)?.snooze_until).toBe(until)
  })

  it('shows the empty state with a way to talk to the agent', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: {} }))
    renderWith(<HomeScreen />, client)
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Talk to Talos' }))
    expect(screen.getByTestId('location').textContent).toBe('/t/general')
  })

  it('"What did I miss?" appears only with a catch-up summary and sends the intent', async () => {
    const client = setup()
    renderWith(<HomeScreen />, client)
    expect(screen.queryByRole('button', { name: 'What did I miss?' })).toBeNull()
    act(() => {
      client.store.setState((s) => ({
        ...s,
        catchup: {
          since_seq: 1,
          threads: [{ thread_id: 'general', unread: 2, last_ts: null, needs_you: false }],
          open_cards: 0,
        },
      }))
    })
    await userEvent.click(screen.getByRole('button', { name: 'What did I miss?' }))
    await waitFor(() => expect(client.sent).toHaveLength(1))
    const frame = client.sent.at(-1) as Record<string, unknown>
    expect(frame.type).toBe('message')
    expect(frame.intent).toBe('what_did_i_miss')
    expect(screen.getByTestId('location').textContent).toBe('/t/general')
  })

  it('the FAB asks the agent in the default thread', async () => {
    renderWith(<HomeScreen />, setup())
    await userEvent.click(screen.getByRole('button', { name: 'Ask Talos' }))
    expect(screen.getByTestId('location').textContent).toBe('/t/general')
  })

  it('search filters rows', async () => {
    const { client } = seeded()
    renderWith(<HomeScreen />, client)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'publish')
    expect(screen.queryByText('Reply to venue')).toBeNull()
    expect(screen.getByText('Publish notes')).toBeTruthy()
  })
})
