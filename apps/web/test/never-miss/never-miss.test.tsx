// P1 "never miss a card or a reply" in the web app (owner calls O2, O19, O21), jsdom against the in-memory fake client.
//   O2   an expired card says "Ask again"; it sends ONE ordinary message naming the card, no card frame.
//   O19  an archived thread says so and offers Restore (the ThreadRowMenu patch path); Mac offline disables it.
//   O21  the phone's icon and the web app's badge are the same number, and both count unread.
import { buildPushPayload, type ThreadT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { formatExpiry } from '../../src/features/cards/util.ts'
import { appBadgeCount, startNativeBadge } from '../../src/features/native/badge.ts'
import { notificationFromPayload } from '../../src/features/pwa/pushLogic.ts'
import { startReadSync } from '../../src/features/pwa/readSync.ts'
import { ArchivedBanner } from '../../src/features/threads/ArchivedBanner.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider, initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { LiveCard, makeCard, renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => useSession.setState({ status: 'authed' }))

const messages = (client: ReturnType<typeof createFakeClient>) => client.sent.filter((f) => f.type === 'message')

describe('O2: Ask again on an expired card', () => {
  it('sends one ordinary message to the card thread that names the card, and no card frame', async () => {
    const card = makeCard({ state: 'expired', title: 'Pay the venue deposit', thread_id: 'general' })
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    await userEvent.click(screen.getByTestId('ask-again'))
    await waitFor(() => expect(screen.getByTestId('ask-again-status').textContent).toMatch(/Asked/))
    const sent = messages(client)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'message', thread_id: 'general' })
    expect(String(sent[0]?.text)).toContain(card.id)
    // The card title is agent-written; it must not ride in a message signed as the owner's words.
    expect(String(sent[0]?.text)).not.toContain('Pay the venue deposit')
    expect(client.sent.filter((f) => String(f.type).startsWith('card'))).toEqual([]) // no new frame, no card.resolve
    expect(screen.queryByTestId('ask-again')).toBeNull() // asked: the button is gone, not a second tap
  })

  it('a card that is pending but past its expiry offers it too; a live, decided or killed card does not', () => {
    const past = makeCard({ state: 'pending', expires_at: '2020-01-01T00:00:00.000Z' })
    const live = makeCard({ state: 'pending' })
    const killed = makeCard({
      state: 'resolved',
      resolution: { action: 'kill', at: '2026-10-28T08:41:00.000Z', edited: false, payload_hash: 'sha256:x' },
    })
    const done = makeCard({
      state: 'done',
      resolution: { action: 'primary', at: '2026-10-28T08:41:00.000Z', edited: false, payload_hash: 'sha256:x' },
      result: { ok: true, text: 'Sent', at: '2026-10-28T08:41:00.000Z' },
    })
    const client = setup({ cards: [past, live, killed, done] })
    for (const [c, want] of [
      [past, true],
      [live, false],
      [killed, false],
      [done, false],
    ] as const) {
      const { unmount } = renderWith(<LiveCard id={c.id} />, client)
      expect(screen.queryByTestId('ask-again') !== null, c.state).toBe(want)
      unmount()
    }
  })

  it('a double tap sends once', async () => {
    const card = makeCard({ state: 'expired' })
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    const btn = screen.getByTestId('ask-again')
    await userEvent.dblClick(btn)
    await waitFor(() => expect(screen.getByTestId('ask-again-status')).toBeTruthy())
    expect(messages(client)).toHaveLength(1)
  })

  it('Mac offline but the relay up: the ask goes out and the card says Asked; with the relay down it says Queued', async () => {
    const card = makeCard({ state: 'expired' })
    // Like the real client: the Mac being away does not queue anything, only a dead socket to the relay does.
    const macAway = setup({ cards: [card], macOffline: true })
    renderWith(<LiveCard id={card.id} />, macAway)
    await userEvent.click(screen.getByTestId('ask-again'))
    await waitFor(() => expect(screen.getByTestId('ask-again-status').textContent).toMatch(/^Asked\./))
    cleanup()

    const noRelay = setup({ cards: [card] })
    noRelay.store.setState({ connection: 'offline' })
    renderWith(<LiveCard id={card.id} />, noRelay)
    await userEvent.click(screen.getByTestId('ask-again'))
    await waitFor(() => expect(screen.getByTestId('ask-again-status').textContent).toMatch(/Queued/))
    cleanup()
  })

  it('a failure says why and leaves the button to try again; an unapproved device says so', async () => {
    const card = makeCard({ state: 'expired' })

    const flaky = setup({ cards: [card] })
    const real = flaky.sendMessage.bind(flaky)
    flaky.sendMessage = vi.fn().mockRejectedValueOnce(new Error('The relay is unreachable.')).mockImplementation(real)
    renderWith(<LiveCard id={card.id} />, flaky)
    await userEvent.click(screen.getByTestId('ask-again'))
    expect((await screen.findByRole('alert')).textContent).toBe('The relay is unreachable.')
    expect(messages(flaky)).toHaveLength(0)
    await userEvent.click(screen.getByTestId('ask-again')) // the button is still there
    await waitFor(() => expect(screen.getByTestId('ask-again-status')).toBeTruthy())
    expect(messages(flaky)).toHaveLength(1)
    cleanup()

    const unpinned = setup({ cards: [card] })
    unpinned.sendMessage = vi.fn().mockResolvedValue({ clientMsgId: 'x', state: 'held_unpinned' })
    renderWith(<LiveCard id={card.id} />, unpinned)
    await userEvent.click(screen.getByTestId('ask-again'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not approved yet/)
  })
})

describe('O19: the archived banner', () => {
  const T = (id: string, over: Partial<ThreadT> = {}): ThreadT =>
    ({
      id,
      name: id,
      kind: 'fixed',
      order: 0,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      ...over,
    }) as ThreadT

  function world(opts: { macOffline?: boolean } = {}) {
    const client = createFakeClient(opts)
    const cfg = client.store.getState().config
    if (!cfg) throw new Error('fake has a config')
    const threads = [...cfg.threads.map((t) => ({ ...t, order: t.order })), T('plans', { order: 9, archived: true })]
    client.store.setState({ config: { ...cfg, threads }, threads })
    const view = render(
      <ClientProvider client={client}>
        <ArchivedBanner thread={threads.find((t) => t.id === 'plans') as ThreadT} />
      </ClientProvider>,
    )
    return { client, view }
  }

  it('says Archived and Restore sends the same config patch the row menu sends, changing only that thread', async () => {
    const { client } = world()
    expect(screen.getByTestId('archived-banner').textContent).toMatch(/Archived/)
    await userEvent.click(screen.getByTestId('archived-restore'))
    await waitFor(() => expect(client.store.getState().threads.find((t) => t.id === 'plans')?.archived).toBe(false))
    const patch = client.sent.find((f) => f.type === 'config.patch') as { patch: { threads: ThreadT[] } } | undefined
    expect(patch?.patch.threads.find((t) => t.id === 'plans')?.archived).toBe(false)
    // every other thread is exactly as it was
    for (const t of client.store.getState().threads.filter((x) => x.id !== 'plans')) expect(t.archived).toBe(false)
  })

  it('Mac offline: Restore is off and says why, exactly as the row menu does', async () => {
    const { client } = world({ macOffline: true })
    const btn = screen.getByTestId('archived-restore') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByTestId('archived-note').textContent).toBe('Your Mac has to be online for this.')
    await userEvent.click(btn)
    expect(client.sent.some((f) => f.type === 'config.patch')).toBe(false)
  })

  it('a refused patch shows the reason and leaves the thread archived', async () => {
    const { client } = world()
    client.failNextPatchWith('config_conflict')
    await userEvent.click(screen.getByTestId('archived-restore'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed the threads at the same time/)
    expect(client.store.getState().threads.find((t) => t.id === 'plans')?.archived).toBe(true)
  })
})

describe('O21: the phone icon and the web badge are one number', () => {
  const NOW = Date.parse('2026-10-31T15:00:00Z')
  const th = (id: string, over: Record<string, unknown> = {}) => ({ id, notify: 'all', archived: false, ...over })
  const card = (id: string, thread_id: string, state = 'pending', expires_at = '2026-10-31T16:00:00Z') => ({
    id,
    thread_id,
    state,
    expires_at,
  })

  function both() {
    const native: number[] = []
    const web: Array<number | 'clear'> = []
    const store = createStore(() => ({
      ...initialClientState(),
      connection: 'online' as const,
      readySeq: 1,
      cards: [] as unknown[],
      unread: {} as Record<string, number>,
      threads: [] as unknown[],
    }))
    const client = { store } as unknown as TalosClient
    const nativeScope = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { TalosPush: { setBadge: async (a: { count: number }) => void native.push(a.count) } },
      },
    }
    const webScope = {
      navigator: {
        setAppBadge: async (n: number) => void web.push(n),
        clearAppBadge: async () => void web.push('clear'),
      },
    }
    startNativeBadge(client, nativeScope, () => NOW)
    startReadSync(
      client,
      webScope,
      () => NOW,
      async () => null,
      () => {},
    )
    return { store, native, web }
  }

  it('open cards (any thread) + unread (minus archived and notify-off threads), identical on both', () => {
    const w = both()
    w.store.setState({
      threads: [
        th('general'),
        th('muted', { notify: 'off' }),
        th('old', { archived: true }),
        th('ny', { notify: 'needs_you' }),
      ],
      unread: { general: 2, muted: 7, old: 5, ny: 1 },
      cards: [
        card('a', 'general'),
        card('b', 'general', 'pending', '2026-10-31T14:00:00Z'), // expired
        card('c', 'general', 'resolved'),
        card('d', 'muted'),
        card('e', 'old'),
      ],
    } as never)
    // 3 open cards (a card in a muted or archived thread still waits on the owner) + unread 2 (general) + 1 (needs-you-only)
    expect(w.native.at(-1)).toBe(6)
    expect(w.web.at(-1)).toBe(6)
    expect(appBadgeCount(w.store.getState() as never, NOW)).toBe(6)
    // a thread read, a card decided: both follow
    w.store.setState({ unread: { general: 0, muted: 7, old: 5, ny: 1 }, cards: [] } as never)
    expect(w.native.at(-1)).toBe(1)
    expect(w.web.at(-1)).toBe(1)
    w.store.setState({ unread: {} } as never)
    expect(w.native.at(-1)).toBe(0)
    expect(w.web.at(-1)).toBe('clear')
  })

  it('archiving a thread with unread messages lowers the number on both', () => {
    const w = both()
    w.store.setState({ threads: [th('general')], unread: { general: 3 }, cards: [] } as never)
    expect(w.native.at(-1)).toBe(3)
    w.store.setState({ threads: [th('general', { archived: true })] } as never)
    expect(w.native.at(-1)).toBe(0)
    expect(w.web.at(-1)).toBe('clear')
  })
})

describe('O21: opening the Inbox clears its webhook items on the relay too', () => {
  it('marks the Inbox read up to the newest frame this device has, not just its last message', async () => {
    const client = setup()
    const msg = {
      id: 'm_0001',
      thread_id: 'inbox',
      author: 'agent' as const,
      kind: 'text' as const,
      text: 'hello from the inbox',
      format: 'plain' as const,
      attachments: [],
      via: 'app' as const,
      seq: 10,
      created_at: '2026-10-31T12:00:00.000Z',
    }
    // 4 webhook items arrived after the last message: seq 11..14 on the relay, so the device's newest frame is 14
    client.store.setState((s) => ({
      ...s,
      messages: { ...s.messages, inbox: [msg] },
      unread: { inbox: 5 },
      lastSeq: 14,
    }))
    const mark = vi.spyOn(client, 'markThreadRead')
    renderWith(<ThreadScreen />, client, '/t/inbox', '/t/:thread')
    await screen.findByText('hello from the inbox')
    await waitFor(() => expect(mark).toHaveBeenCalled())
    expect(mark.mock.calls.at(-1)?.[0]).toBe('inbox')
    expect(mark.mock.calls.at(-1)?.[1]).toBe(14) // 10 would leave the four items unread on the relay for good
  })

  it('another thread still marks up to its own last message', async () => {
    const client = setup()
    const msg = {
      id: 'm_0002',
      thread_id: 'general',
      author: 'agent' as const,
      kind: 'text' as const,
      text: 'hello from general',
      format: 'plain' as const,
      attachments: [],
      via: 'app' as const,
      seq: 10,
      created_at: '2026-10-31T12:00:00.000Z',
    }
    client.store.setState((s) => ({
      ...s,
      messages: { ...s.messages, general: [msg] },
      unread: { general: 1 },
      lastSeq: 14,
    }))
    const mark = vi.spyOn(client, 'markThreadRead')
    renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')
    await screen.findByText('hello from general')
    await waitFor(() => expect(mark).toHaveBeenCalled())
    expect(mark.mock.calls.at(-1)?.[1]).toBe(10)
  })
})

describe('O2: a card that can live a day says which day it expires', () => {
  const now = Date.parse('2026-10-31T21:00:00Z') // 14:00 in the UTC-7 zone
  it('same day: the time; tomorrow: "tomorrow"; later in the week: the weekday; far off: the date', () => {
    const tz = 'Etc/GMT+7'
    expect(formatExpiry('2026-11-01T01:30:00Z', tz, now)).toBe('18:30') // 18:30 today
    expect(formatExpiry('2026-11-01T21:00:00Z', tz, now)).toBe('tomorrow 14:00')
    expect(formatExpiry('2026-11-03T21:00:00Z', tz, now)).toBe('Tue 14:00')
    expect(formatExpiry('2026-12-25T21:00:00Z', tz, now)).toBe('2026-12-25 14:00')
  })
  it('judges the day in the agent zone, not UTC: 23:00 in the UTC-7 zone is already tomorrow in UTC', () => {
    expect(formatExpiry('2026-11-01T06:00:00Z', 'Etc/GMT+7', now)).toBe('23:00')
    expect(formatExpiry('2026-11-01T06:00:00Z', 'UTC', now)).toBe('tomorrow 06:00')
  })
  it('the card shows it: a background card with a day to live says "tomorrow", not a bare clock time', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.parse('2026-10-31T21:00:00Z'))
      const card = makeCard({ origin: 'background', expires_at: '2026-11-01T21:00:00.000Z' })
      renderWith(<LiveCard id={card.id} />, setup({ cards: [card] }))
      expect(screen.getByTestId('card-expiry').textContent).toBe('Expires tomorrow 21:00 if untouched')
    } finally {
      vi.useRealTimers()
    }
  })
  it('an unreadable instant is empty, and a bad zone falls back instead of throwing', () => {
    expect(formatExpiry('nope', 'UTC', now)).toBe('')
    expect(() => formatExpiry('2026-11-01T21:00:00Z', 'Not/AZone', now)).not.toThrow()
  })
})

describe('O2: the web push for the reminder asks to alert again', () => {
  it('card_expiring sets renotify on the shown notification; needs_you does not', () => {
    const cfg = { agent: { name: 'Talos' }, notifications: { show_thread_names: 'fixed_only' as const }, threads: [] }
    const ids = { thread_id: 'general', card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0' }
    const exp = notificationFromPayload(buildPushPayload({ template: 'card_expiring', ...ids }, cfg))
    const need = notificationFromPayload(buildPushPayload({ template: 'needs_you', ...ids }, cfg))
    expect(exp.options.tag).toBe(need.options.tag)
    expect(exp.options.renotify).toBe(true)
    expect(need.options.renotify).toBeUndefined()
  })
})
