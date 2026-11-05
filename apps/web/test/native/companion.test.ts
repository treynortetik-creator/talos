// @vitest-environment node
// The companion feed (DESKTOP-COMPANION-SPEC 7): the real socket client against the testkit FakeRelay feeds the real
// store, the real session controller and the real bridge; the test reads what the bridge posted.
import { AgentConfig, type CardT, Message, newId, WebToNative } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import sessionStateFixture from '@talos-app/protocol/fixtures/frames/session.state.json'
import { buildCard, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { attachShell, NATIVE_FEATURES } from '../../src/features/native/attach.ts'
import {
  buildCompanionFrame,
  type CompanionFrame,
  lastReplyText,
  startCompanionFeed,
} from '../../src/features/native/companion.ts'
import { getSessionController } from '../../src/features/session/store.ts'
import { initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import type { Shell } from '../../src/lib/native/shell.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const NOW = Date.parse('2026-10-28T16:00:00.000Z')
const config = AgentConfig.parse(readyFixture.agent_config)

// ---- the pure builder -----------------------------------------------------------------------------------------------

const thread = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, name: id, kind: 'fixed', created_at: '2026-10-01T00:00:00.000Z', ...over }) as never
const base = () => ({ ...initialClientState(), config })
const input = (state: ReturnType<typeof base>, over: Record<string, unknown> = {}) => ({
  state,
  signedIn: true,
  busy: false,
  failed: 0,
  lastReply: null,
  nowMs: NOW,
  ...over,
})

describe('buildCompanionFrame', () => {
  it('signed out is one frame of zeros and no rows, whatever the cached store holds', () => {
    const s = {
      ...base(),
      threads: [thread('general')],
      unread: { general: 4 },
      cards: [buildCard({ thread_id: 'general' }, new Date(NOW))],
      statuses: { general: { thread_id: 'general', state: 'working', since: '2026-10-28T15:00:00.000Z' } },
    } as never
    const f = buildCompanionFrame(input(s, { signedIn: false, busy: true, failed: 3 }))
    expect(f).toMatchObject({
      needs: 0,
      working: 0,
      queued: 0,
      on_call: 0,
      unread: 0,
      failed: 0,
      busy: false,
      rows: [],
    })
    expect(f.last_reply).toBeNull()
    expect(WebToNative.safeParse(f).success).toBe(true)
  })

  it('counts needs (not expired, not altered), statuses and unread (not archived, not system)', () => {
    const live = buildCard({ thread_id: 'general' }, new Date(NOW))
    const expired = { ...buildCard({ thread_id: 'general' }, new Date(NOW - 2 * 86_400_000)) }
    const altered: CardT = { ...buildCard({ thread_id: 'general' }, new Date(NOW)), title: 'changed after the hash' }
    const s = {
      ...base(),
      threads: [
        thread('general'),
        thread('daily'),
        thread('old', { archived: true }),
        thread('sys', { kind: 'system' }),
      ],
      unread: { general: 2, daily: 1, old: 9, sys: 9 },
      cards: [live, expired, altered],
      statuses: {
        general: { thread_id: 'general', state: 'working', since: '2026-10-28T15:00:00.000Z' },
        daily: { thread_id: 'daily', state: 'queued', since: '2026-10-28T15:00:00.000Z' },
        old: { thread_id: 'old', state: 'on_call', since: '2026-10-28T15:00:00.000Z' },
      },
    } as never
    const f = buildCompanionFrame(input(s, { busy: true, failed: 2 }))
    expect(f).toMatchObject({ needs: 1, working: 1, queued: 1, on_call: 1, unread: 3, failed: 2, busy: true })
    expect(f.link).toBe('connecting')
  })

  it("rows follow Home's order (needs you, ready, working, queued), one per thread, first wins", () => {
    const card = buildCard({ thread_id: 'a' }, new Date(NOW))
    const s = {
      ...base(),
      threads: [thread('a'), thread('b'), thread('c'), thread('d')],
      cards: [card],
      unread: { a: 1, b: 1 },
      statuses: {
        a: { thread_id: 'a', state: 'working', since: '2026-10-28T15:00:00.000Z' },
        c: { thread_id: 'c', state: 'working', since: '2026-10-28T15:00:00.000Z' },
        d: { thread_id: 'd', state: 'queued', since: '2026-10-28T15:00:00.000Z' },
      },
    } as never
    expect(buildCompanionFrame(input(s)).rows).toEqual([
      { thread_id: 'a', state: 'needs_you' }, // a is also working: the card wins
      { thread_id: 'b', state: 'ready' },
      { thread_id: 'c', state: 'working' },
      { thread_id: 'd', state: 'queued' },
    ])
  })

  it('a thread the agent set to needs_you with no card is a needs-you row and counts once, even with unread', () => {
    const card = buildCard({ thread_id: 'withcard' }, new Date(NOW))
    const st = (id: string, state: string) => ({ thread_id: id, state, since: '2026-10-28T15:00:00.000Z' })
    const s = {
      ...base(),
      threads: [
        thread('flag'),
        thread('withcard'),
        thread('old', { archived: true }),
        thread('sys', { kind: 'system' }),
        thread('later'),
      ],
      cards: [card],
      unread: { flag: 2, withcard: 1 },
      statuses: {
        flag: st('flag', 'needs_you'),
        withcard: st('withcard', 'needs_you'), // a card is already on it: one count, not two
        old: st('old', 'needs_you'),
        sys: st('sys', 'needs_you'),
        later: st('later', 'working'),
      },
    } as never
    const f = buildCompanionFrame(input(s))
    expect(f.needs).toBe(2)
    expect(f.rows).toEqual([
      { thread_id: 'withcard', state: 'needs_you' },
      { thread_id: 'flag', state: 'needs_you' },
      { thread_id: 'later', state: 'working' },
    ])
    expect(WebToNative.safeParse(f).success).toBe(true)
    // Signed out, none of it shows.
    expect(buildCompanionFrame(input(s, { signedIn: false }))).toMatchObject({ needs: 0, rows: [] })
  })

  it('caps rows at 12 and drops a row whose id the bridge would refuse, not the frame', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const s = {
      ...base(),
      threads: [thread('Bad Id'), ...ids.map((id) => thread(id))],
      statuses: Object.fromEntries(
        ['Bad Id', ...ids].map((id) => [id, { thread_id: id, state: 'working', since: '2026-10-28T15:00:00.000Z' }]),
      ),
    } as never
    const f = buildCompanionFrame(input(s))
    expect(f.rows).toHaveLength(12)
    expect(f.rows.every((r) => /^t\d+$/.test(r.thread_id))).toBe(true)
    expect(WebToNative.safeParse(f).success).toBe(true)
  })

  it('an unknown future thread status degrades its own count only', () => {
    const s = {
      ...base(),
      threads: [thread('a')],
      statuses: { a: { thread_id: 'a', state: 'meditating', since: '2026-10-28T15:00:00.000Z' } },
    } as never
    const f = buildCompanionFrame(input(s))
    expect(f).toMatchObject({ working: 0, queued: 0, on_call: 0, rows: [] })
  })

  it('clamps a huge count into the schema instead of losing the frame', () => {
    const s = { ...base(), threads: [thread('a')], unread: { a: 1_000_000 } } as never
    const f = buildCompanionFrame(input(s, { failed: 1_000_000 }))
    expect(f.unread).toBe(99_999)
    expect(f.failed).toBe(99_999)
    expect(WebToNative.safeParse(f).success).toBe(true)
  })
})

// ---- last reply text ------------------------------------------------------------------------------------------------

describe('lastReplyText', () => {
  const msg = (over: Record<string, unknown>) =>
    Message.parse({
      id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text: 'x',
      format: 'markdown',
      created_at: '2026-10-28T15:00:00.000Z',
      ...over,
    })
  it('takes the newest AGENT message, as plain text', () => {
    const messages = {
      general: [
        msg({ text: 'old' }),
        msg({ text: '**Done** with [the link](https://x.test/a).' }),
        msg({ author: 'owner', text: 'thanks' }),
      ],
    }
    expect(lastReplyText(messages, 'general')).toEqual({
      text: 'Done with the link (https://x.test/a).',
      truncated: false,
    })
  })
  it('null when nothing is loaded, the thread is unknown, or the message has no text', () => {
    expect(lastReplyText({}, 'general')).toEqual({ text: null, truncated: false })
    expect(lastReplyText({ general: [msg({ author: 'owner' })] }, 'general').text).toBeNull()
    expect(lastReplyText({ general: [msg({ text: undefined, kind: 'file' })] }, 'general').text).toBeNull()
    expect(lastReplyText({ general: [msg({ text: ' \u0000\u202e ' })] }, 'general').text).toBeNull()
  })
  it('strips the invisible characters that hide or reorder text, and keeps joiners that are part of the text', () => {
    const t = (text: string) => lastReplyText({ general: [msg({ text })] }, 'general').text
    expect(t('a\u061cb\u00adc\u{e0041}\u{e0067}d\u180ee\u{e0100}f')).toBe('abcdef')
    // a ZWJ emoji and Persian ZWNJ are real text
    expect(t('x \u{1f469}\u200d\u{1f4bb} y')).toBe('x \u{1f469}\u200d\u{1f4bb} y')
    expect(t('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645')).toBe(
      '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
    )
    // a joiner at an edge, next to a space, or doubled up hides nothing legitimate
    expect(t('\u200da \u200c b\u200d')).toBe('a  b')
    expect(t('a\u200d\u200db')).toBe('ab')
    // a ZWNJ in a letter-less run is dropped
    expect(t('1\u200d-\u200d2')).toBe('1-2')
  })
  it('strips control, bidi and format characters and caps at 500 without splitting a surrogate pair', () => {
    const hostile = lastReplyText({ general: [msg({ text: 'a\u0000b\u202ec\u200bd\u001b[31me\nf' })] }, 'general')
    expect(hostile.text).toBe('abcd[31me\nf')
    const long = lastReplyText({ general: [msg({ text: `${'a'.repeat(499)}😀tail` })] }, 'general')
    expect(long.truncated).toBe(true)
    expect(long.text).toBe('a'.repeat(499)) // the emoji straddles 500 units: dropped whole, not split
    expect(lastReplyText({ general: [msg({ text: 'a'.repeat(500) })] }, 'general')).toMatchObject({ truncated: false })
  })
})

// ---- the feed against the real socket client ---------------------------------------------------------------------

let relay: FakeRelay
let client: SocketClient
let posted: Array<Record<string, unknown>>
let feed: ReturnType<typeof startCompanionFeed> | null

const companionFrames = () => posted.filter((m) => m.type === 'companion_state') as unknown as CompanionFrame[]
const lastFrame = () => companionFrames().at(-1) as CompanionFrame
const bridgeOf = () => createShellBridge({ post: (m) => posted.push(m as Record<string, unknown>) })

beforeEach(async () => {
  posted = []
  feed = null
  useSession.setState({ status: 'authed' })
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  feed?.stop()
  client.close()
  await relay.stop()
  useSession.setState({ status: 'anon' })
})

/** Waits until `n` messages are in the store (the replies the test sent were applied), then lets any frame they would raise go out. */
const processed = async (n: number) => {
  await waitFor(
    () => Object.values(client.store.getState().messages).reduce((t, l) => t + l.length, 0) >= n,
    3000,
    `${n} messages`,
  )
  await new Promise((r) => setTimeout(r, 60))
}

const reply = (over: Record<string, unknown> = {}, seq?: number, threadId = 'general') =>
  mkFrame('reply', {
    ...(seq === undefined ? {} : { relay: { seq, received_at: new Date().toISOString() } }),
    message: {
      id: newId('m'),
      thread_id: threadId,
      author: 'agent',
      kind: 'text',
      text: 'SECRET REPLY TEXT',
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: new Date().toISOString(),
    },
    ...over,
  })

describe('the feed, against the real client store', () => {
  it('a card, a status and a reply each reach a valid frame; nothing else is in it', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first frame')
    expect(lastFrame()).toMatchObject({ link: 'online', needs: 0, rows: [], last_reply: null })

    const card = buildCard({ thread_id: 'general', title: 'SECRET CARD TITLE' })
    relay.sendToApps(mkFrame('card.create', { card }))
    relay.sendToApps(mkFrame('status', { thread_id: 'inbox', state: 'working', since: new Date().toISOString() }))
    relay.sendToApps(reply({}, 4242))
    await waitFor(
      () => lastFrame().last_reply?.seq === 4242 && lastFrame().needs === 1 && lastFrame().working === 1,
      3000,
      'state in frame',
    )
    const f = lastFrame()
    expect(f.rows).toEqual([
      { thread_id: 'general', state: 'needs_you' },
      { thread_id: 'inbox', state: 'working' },
    ])
    expect(f.last_reply).toEqual({ thread_id: 'general', seq: 4242 })
    expect(f.unread).toBe(1)
    expect(feed.dropped).toBe(0)
    // Every frame the bridge accepted is valid, and none holds a thread name, a card title or a word of a reply.
    const all = JSON.stringify(companionFrames())
    for (const secret of ['SECRET', ...client.store.getState().threads.map((t) => t.name)])
      expect(all).not.toContain(secret)
    for (const fr of companionFrames()) expect(WebToNative.safeParse(fr).success).toBe(true)
  })

  it('a reply with no relay seq, a silent one, a voice one, an owner one and a muted thread raise nothing', async () => {
    const muted = AgentConfig.parse({
      ...readyFixture.agent_config,
      threads: config.threads.map((t) => (t.id === 'inbox' ? { ...t, notify: 'off' } : t)),
    })
    client.store.setState({ config: muted })
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first frame')
    const owner = reply({}, 13) as unknown as { message: { author: string } }
    owner.message.author = 'owner'
    const ignored = [
      reply({}, undefined),
      reply({ silent: true }, 10),
      reply({ voice_delegation_id: 'v_1' }, 11),
      reply({}, 12, 'inbox'),
      owner,
    ]
    // One at a time, each proven to have reached the store, then given time to (wrongly) produce a frame.
    for (const [i, f] of ignored.entries()) {
      relay.sendToApps(f)
      await processed(i + 1)
      expect(lastFrame().last_reply, `ignored reply #${i}`).toBeNull()
    }
    relay.sendToApps(reply({}, 14))
    await waitFor(() => lastFrame().last_reply !== null, 3000, 'good reply')
    expect(lastFrame().last_reply).toEqual({ thread_id: 'general', seq: 14 })
    expect(feed.dropped).toBe(0) // a reply with no seq must not become a frame the bridge refuses (that would blind the pet)
  })

  it('a "Needs you only" thread raises no last_reply for a plain reply, and an "all" thread still does', async () => {
    const quiet = AgentConfig.parse({
      ...readyFixture.agent_config,
      threads: config.threads.map((t) => (t.id === 'inbox' ? { ...t, notify: 'needs_you' } : t)),
    })
    client.store.setState({ config: quiet })
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first frame')
    relay.sendToApps(reply({}, 20, 'inbox'))
    await processed(1)
    expect(lastFrame().last_reply).toBeNull()
    relay.sendToApps(reply({}, 21, 'general'))
    await waitFor(() => lastFrame().last_reply !== null, 3000, 'general reply')
    expect(lastFrame().last_reply).toEqual({ thread_id: 'general', seq: 21 })
  })

  it('last_reply.seq only rises: a replayed older reply does not move it', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    relay.sendToApps(reply({}, 50))
    await waitFor(() => lastFrame()?.last_reply?.seq === 50, 3000, '50')
    relay.sendToApps(reply({}, 40))
    await processed(2)
    expect(lastFrame().last_reply?.seq).toBe(50) // 40 arrived (it is in the store) and was ignored
    relay.sendToApps(reply({}, 50))
    await processed(3)
    expect(lastFrame().last_reply?.seq).toBe(50)
    relay.sendToApps(reply({}, 51, 'inbox'))
    await waitFor(() => lastFrame().last_reply?.seq === 51, 3000, '51')
    expect(lastFrame().last_reply).toEqual({ thread_id: 'inbox', seq: 51 })
  })

  it('sign-out sends zeros and drops the last reply; signing back in does not resurrect it', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    relay.sendToApps(reply({}, 70))
    relay.sendToApps(mkFrame('card.create', { card: buildCard({ thread_id: 'general' }) }))
    await waitFor(() => lastFrame()?.last_reply?.seq === 70 && lastFrame().needs === 1, 3000, 'populated')
    // The feed ticks once a minute here (tickMs), so a frame that clears within this wait came from the sign-out itself.
    // The wait only caps a hang; how fast the machine is does not decide the test.
    useSession.setState({ status: 'anon' })
    await waitFor(() => lastFrame().needs === 0, 8000, 'cleared')
    expect(lastFrame()).toMatchObject({ rows: [], unread: 0, last_reply: null, mac_online: false })
    useSession.setState({ status: 'authed' })
    await waitFor(() => lastFrame().needs === 1, 8000, 'back')
    expect(lastFrame().last_reply).toBeNull()
  })

  it('failed comes from the client meta (a send that did not go through)', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first')
    client.meta.setState({ failed: { m_01JBF3V7Q8K2M4N6P8R0S2T4AA: 'retry' } })
    await waitFor(() => lastFrame().failed === 1, 2000, 'failed 1')
    client.meta.setState({ failed: {} })
    await waitFor(() => lastFrame().failed === 0, 2000, 'failed 0')
  })

  it('busy follows the live mod, and a hidden page still gets it because the feed starts the controller', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first')
    expect(lastFrame().busy).toBe(false)
    const state = { ...sessionStateFixture.state, at: new Date().toISOString(), busy: true }
    relay.sendToApps(mkFrame('session.state', { state }))
    await waitFor(() => lastFrame().busy === true, 3000, 'busy true')
    relay.sendToApps(mkFrame('session.state', { state: { ...state, busy: false } }))
    await waitFor(() => lastFrame().busy === false, 3000, 'busy false')
  })

  it('mac_online and link follow presence and the connection', async () => {
    feed = startCompanionFeed(client, bridgeOf(), { coalesceMs: 5, tickMs: 60_000 })
    await waitFor(() => companionFrames().length >= 1, 2000, 'first')
    client.store.setState((s) => ({ presence: { ...s.presence, bridge_online: !s.presence.bridge_online } }))
    const flipped = client.store.getState().presence.bridge_online
    await waitFor(() => lastFrame().mac_online === flipped, 2000, 'presence')
    client.store.setState({ connection: 'offline' })
    await waitFor(() => lastFrame().link === 'offline', 2000, 'link')
  })
})

// ---- timers, counters, teardown ------------------------------------------------------------------------------------

describe('coalescing, the 30 s tick and stop', () => {
  function fakeClient() {
    const store = createStore(() => ({ ...initialClientState(), config, threads: config.threads }))
    const listeners: Record<string, Array<(f: unknown) => void>> = {}
    const c = {
      store,
      onFrame(type: string, fn: (f: unknown) => void) {
        const list = listeners[type] ?? []
        listeners[type] = list
        list.push(fn)
        return () => {
          list.splice(list.indexOf(fn), 1)
        }
      },
    } as unknown as TalosClient
    return { c, store, listeners }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    useSession.setState({ status: 'authed' })
  })
  afterEach(() => {
    vi.useRealTimers()
    useSession.setState({ status: 'anon' })
  })

  it('a burst of changes is one frame after 250 ms; an identical state sends nothing more', () => {
    const { c, store } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    for (let i = 0; i < 20; i++) store.setState({ unread: { general: i } })
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(249)
    expect(out).toHaveLength(0)
    vi.advanceTimersByTime(2)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'companion_state', unread: 19 })
    store.setState({ unread: { general: 19 } }) // a store change that does not change the frame
    vi.advanceTimersByTime(1000)
    expect(out).toHaveLength(1)
    h.stop()
  })

  it('the 30 s tick always sends, even when nothing changed, so the shell can tell a live page from a silent one', () => {
    const { c } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    expect(out).toHaveLength(2)
    vi.advanceTimersByTime(30_000)
    expect(out).toHaveLength(3)
    expect(JSON.stringify(out[1])).toBe(JSON.stringify(out[2]))
    h.stop()
  })

  it('a card expiring with no store change is noticed by the tick', () => {
    const { c, store } = fakeClient()
    const clock = { t: NOW }
    const card = buildCard({ thread_id: 'general' }, new Date(NOW - 86_400_000 + 20_000)) // expires 20 s from NOW
    store.setState({ cards: [card] })
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => clock.t,
    })
    vi.advanceTimersByTime(300)
    expect(out.at(-1)).toMatchObject({ needs: 1 })
    clock.t = NOW + 25_000
    vi.advanceTimersByTime(30_000)
    expect(out.at(-1)).toMatchObject({ needs: 0 })
    h.stop()
  })

  it('a clock that jumps backward and forward never breaks the cadence (the cadence is timers, not wall time)', () => {
    const { c } = fakeClient()
    const clock = { t: NOW }
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => clock.t,
    })
    vi.advanceTimersByTime(300)
    clock.t = NOW - 3 * 3_600_000
    vi.advanceTimersByTime(30_000)
    clock.t = NOW + 9 * 3_600_000
    vi.advanceTimersByTime(30_000)
    expect(out).toHaveLength(3)
    h.stop()
  })

  it('a sign-out and sign-in inside one window still resends: the shell threw its feed away at the ready in between', () => {
    const { c, store } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    store.setState({ unread: { general: 2 } })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(1)
    useSession.setState({ status: 'anon' })
    vi.advanceTimersByTime(100) // inside the 250 ms window: the zeros frame has not gone yet
    useSession.setState({ status: 'authed' })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ type: 'companion_state', unread: 2 })
    h.stop()
  })

  it('the session controller 5 s tick (a patch of `now`) does not wake the feed; a busy flip does', () => {
    const { c } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(1)
    const ctl = getSessionController(c)
    const timers = vi.getTimerCount()
    for (let i = 0; i < 5; i++) ctl.store.setState({ now: NOW + i * 5000 })
    expect(vi.getTimerCount(), 'a tick armed a recompute').toBe(timers)
    ctl.store.setState({ modOnline: true, state: { ...sessionStateFixture.state, busy: true } as never })
    expect(vi.getTimerCount(), 'a busy flip must arm one').toBe(timers + 1)
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ busy: true })
    h.stop()
  })

  it('a sign-out and sign-in inside one window does not carry the old last_reply into the new session', () => {
    const { c, store, listeners } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    store.setState({ unread: { general: 1 } })
    for (const fn of listeners.reply ?? [])
      fn({
        message: { author: 'agent', thread_id: 'general' },
        relay: { seq: 7, received_at: '2026-10-28T15:00:00.000Z' },
      })
    vi.advanceTimersByTime(300)
    expect(out.at(-1)).toMatchObject({ last_reply: { thread_id: 'general', seq: 7 } })
    useSession.setState({ status: 'anon' })
    vi.advanceTimersByTime(100) // no frame has been computed while signed out
    useSession.setState({ status: 'authed' })
    vi.advanceTimersByTime(300)
    expect(out.at(-1)).toMatchObject({ unread: 1, last_reply: null })
    h.stop()
  })

  it('pinning the device resends too (ready flips signed_in with it)', () => {
    const { c, store } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(1)
    store.setState({ devicePinned: true })
    vi.advanceTimersByTime(300)
    expect(out).toHaveLength(2) // the frame is identical, and it still goes
    h.stop()
  })

  it('a refused send is counted, not remembered as sent, and tried again at the next change or tick', () => {
    const { c, store } = fakeClient()
    let accept = false
    const out: Array<Record<string, unknown>> = []
    const bridge = createShellBridge({
      post: (m) => {
        if (!accept) throw new Error('web view gone')
        out.push(m as Record<string, unknown>)
      },
    })
    const h = startCompanionFeed(c, bridge, { now: () => NOW })
    vi.advanceTimersByTime(300)
    expect(h.dropped).toBe(1)
    expect(h.sent).toBe(0)
    accept = true
    vi.advanceTimersByTime(6000) // short of the 30 s tick, and nothing changed: nothing is retried
    expect(h.sent).toBe(0)
    store.setState({ unread: { general: 1 } }) // the next change retries
    vi.advanceTimersByTime(300)
    expect(h.sent).toBe(1)
    expect(out).toHaveLength(1)
    h.stop()
  })

  it('a refused send is also retried by the 30 s tick when nothing changes', () => {
    const { c } = fakeClient()
    let accept = false
    const out: Array<Record<string, unknown>> = []
    const h = startCompanionFeed(
      c,
      createShellBridge({
        post: (m) => {
          if (!accept) throw new Error('web view gone')
          out.push(m as Record<string, unknown>)
        },
      }),
      { now: () => NOW },
    )
    vi.advanceTimersByTime(300)
    expect(h.dropped).toBe(1)
    accept = true
    vi.advanceTimersByTime(30_000)
    expect(h.sent).toBe(1)
    expect(out).toHaveLength(1)
    h.stop()
  })

  it('an invalid frame (the bridge refuses it) is counted too', () => {
    const { c } = fakeClient()
    const bridge = createShellBridge({ post: () => {} })
    const spy = vi.spyOn(bridge, 'send').mockReturnValue(false)
    const h = startCompanionFeed(c, bridge, { now: () => NOW })
    vi.advanceTimersByTime(300)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(h.dropped).toBe(1)
    h.stop()
  })

  it('stop removes every listener, the pending frame, the tick and the controller start', () => {
    const { c, store, listeners } = fakeClient()
    const out: Array<Record<string, unknown>> = []
    const before = vi.getTimerCount()
    const h = startCompanionFeed(c, createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) }), {
      now: () => NOW,
    })
    store.setState({ unread: { general: 1 } }) // a frame is now pending
    expect(vi.getTimerCount()).toBeGreaterThan(before)
    h.stop()
    h.stop() // twice is harmless
    expect(vi.getTimerCount()).toBe(before)
    expect(listeners.reply ?? []).toHaveLength(0)
    store.setState({ unread: { general: 2 } })
    useSession.setState({ status: 'anon' })
    vi.advanceTimersByTime(120_000)
    expect(out).toHaveLength(0)
  })
})

// ---- the reply request ---------------------------------------------------------------------------------------------

describe('companion_reply_request through attachShell', () => {
  function shellRig(pinned: boolean) {
    const out: Array<Record<string, unknown>> = []
    const bridge = createShellBridge({ post: (m) => out.push(m as Record<string, unknown>) })
    const store = createStore(() => ({
      ...initialClientState(),
      config,
      devicePinned: pinned,
      threads: config.threads,
      messages: {
        general: [
          Message.parse({
            id: newId('m'),
            thread_id: 'general',
            author: 'agent',
            kind: 'text',
            text: '**Hello** from the agent',
            format: 'markdown',
            created_at: '2026-10-28T15:00:00.000Z',
          }),
        ],
      },
    }))
    const c = { store, sendMessage: vi.fn(), onFrame: () => () => {} } as unknown as TalosClient
    const shell = { kind: 'desktop', bridge, platform: {} } as unknown as Shell
    return { out, bridge, c, shell }
  }
  beforeEach(() => useSession.setState({ status: 'anon' }))

  it('advertises companion/1', () => {
    expect(NATIVE_FEATURES).toContain('companion/1')
    const t = shellRig(true)
    attachShell(t.shell, t.c)
    expect(t.out[0]).toMatchObject({ type: 'ready' })
    expect(t.out[0]?.features).toContain('companion/1')
  })

  it('signed in: answers with the request id, the thread id and plain text', () => {
    const t = shellRig(true)
    useSession.setState({ status: 'authed' })
    const stop = attachShell(t.shell, t.c)
    expect(t.bridge.receive({ type: 'companion_reply_request', req: 'r12', thread_id: 'general' })).toBe(true)
    expect(t.out.at(-1)).toEqual({
      type: 'companion_reply',
      req: 'r12',
      thread_id: 'general',
      text: 'Hello from the agent',
      truncated: false,
    })
    expect(t.bridge.receive({ type: 'companion_reply_request', req: 'r13', thread_id: 'inbox' })).toBe(true)
    expect(t.out.at(-1)).toEqual({
      type: 'companion_reply',
      req: 'r13',
      thread_id: 'inbox',
      text: null,
      truncated: false,
    })
    stop()
  })

  it('signed out, or not pinned: refused (receive answers false) and nothing is posted', () => {
    const t = shellRig(true)
    const stop = attachShell(t.shell, t.c) // status anon
    const n = t.out.length
    expect(t.bridge.receive({ type: 'companion_reply_request', req: 'r1', thread_id: 'general' })).toBe(false)
    expect(t.out.filter((m) => m.type === 'companion_reply')).toHaveLength(0)
    expect(t.out).toHaveLength(n)
    stop()
    const u = shellRig(false)
    useSession.setState({ status: 'authed' })
    const stop2 = attachShell(u.shell, u.c)
    expect(u.bridge.receive({ type: 'companion_reply_request', req: 'r1', thread_id: 'general' })).toBe(false)
    expect(u.out.filter((m) => m.type === 'companion_reply')).toHaveLength(0)
    stop2()
  })

  it('a malformed request is refused by the bridge before any handler sees it', () => {
    const t = shellRig(true)
    useSession.setState({ status: 'authed' })
    const stop = attachShell(t.shell, t.c)
    for (const bad of [
      { type: 'companion_reply_request', req: '', thread_id: 'general' },
      { type: 'companion_reply_request', req: 'r 1', thread_id: 'general' },
      { type: 'companion_reply_request', req: 'r1', thread_id: 'ALL' },
      { type: 'companion_reply_request', req: 'r1', thread_id: 'general', text: 'x' },
    ])
      expect(t.bridge.receive(bad)).toBe(false)
    expect(t.out.filter((m) => m.type === 'companion_reply')).toHaveLength(0)
    stop()
  })

  it('the teardown attachShell returns stops the feed too', () => {
    vi.useFakeTimers()
    try {
      const t = shellRig(true)
      useSession.setState({ status: 'authed' })
      const before = vi.getTimerCount()
      const stop = attachShell(t.shell, t.c)
      vi.advanceTimersByTime(300)
      expect(t.out.some((m) => m.type === 'companion_state')).toBe(true)
      stop()
      expect(vi.getTimerCount()).toBeLessThanOrEqual(before)
      const n = t.out.length
      vi.advanceTimersByTime(120_000)
      expect(t.out).toHaveLength(n)
    } finally {
      vi.useRealTimers()
    }
  })
})
