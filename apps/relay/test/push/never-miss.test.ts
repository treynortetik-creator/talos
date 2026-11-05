// P1 "never miss a card or a reply" (owner calls O2, O7, O21), on the REAL relay (hub, store, CorePush, the two new timers)
// with an injected fake clock and a recording push transport. Nothing here fakes the thing under test: the bridge side is
// a FakeBridge speaking the real wire, the clock is the one the relay's timers use.
//
//   O2   card_expiring: one reminder about an hour before a card dies, only for cards that had 2 h or more, never twice,
//        not across a relay restart, held by the quiet window, the master switch and a thread set to off.
//   O7   quiet_summary: what the quiet window held back, as counts, once, when it ends.
//   O21  the badge in each push = open cards + unread, archived and notify-off threads left out.
import {
  type AgentConfigT,
  badgeCount,
  buildPushPayload,
  PUSH_TTL_S,
  pushTtlSeconds,
  quietSummaryBody,
} from '@talos-app/protocol'
import { type FakeBridge, type FakeClock, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import { readQuietHeld } from '../../src/core/quiet-summary.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 120_000 })

const SUB = { endpoint: 'https://push.example.com/send/never-miss', keys: { p256dh: 'a', auth: 'b' } }
const HOUR = 3_600_000
// A fixed UTC-7 zone (no DST), as a user in a no-DST zone would have it, with a quiet window of 20:30-04:00 local.
const QUIET = { start: '20:30', end: '04:00' }
/** UTC-7 wall time on 2026-10-30 (`day` 0) or a later day, as an ISO instant. */
const utc7 = (hhmm: string, day = 0) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return new Date(Date.UTC(2026, 9, 30 + day, h + 7, m)).toISOString()
}

const relays: TestRelay[] = []
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
})

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  icon: '💬',
  kind: 'fixed' as const,
  order: 5,
  notify: 'all' as const,
  voice_context: 'recent' as const,
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})

let revCounter = 1
const cfgOf = (over: Partial<AgentConfigT> = {}): AgentConfigT =>
  ({
    ...DEFAULT_AGENT_CONFIG,
    timezone: 'Etc/GMT+7',
    quiet_window: QUIET,
    ...over,
  }) as AgentConfigT

async function applyConfig(r: TestRelay, b: FakeBridge, over: Partial<AgentConfigT> = {}) {
  const rev = ++revCounter
  b.send({ type: 'config.sync', config: { ...cfgOf(over), rev }, rev })
  await waitFor(() => r.runtime.hub.agentConfig()?.rev === rev, 3000, `config rev ${rev}`)
}

async function relayOn(clock: FakeClock, extra: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay({ clock, ...extra })
  relays.push(r)
  r.runtime.store.putSub(SUB)
  return r
}
const bridgeFor = (r: TestRelay) => kit(r).bridge({ autoReply: false }).connect()
const gone = async (r: TestRelay, b: FakeBridge) => {
  await b.close()
  await waitFor(() => !r.relay.services.bus.bridgeOnline(), 3000, 'relay sees the bridge gone')
}

type Sent = TestRelay['transport']['sent'][number]
const sent = (r: TestRelay): Sent[] => r.transport.sent
const reminders = (r: TestRelay) => sent(r).filter((s) => /expires soon/.test(s.payload.notification.body))
const summaries = (r: TestRelay) =>
  sent(r).filter((s) => s.payload.talos.kind === 'digest' && !s.payload.notification.body.startsWith('Overnight'))
const replyPushes = (r: TestRelay) => sent(r).filter((s) => s.payload.talos.kind === 'reply')
const everything = (r: TestRelay) => JSON.stringify(sent(r).map((s) => s.payload))

/** A card for `general` that starts now (the fake clock's now) and lives `lifeMs`. */
async function card(r: TestRelay, b: FakeBridge, c: FakeClock, lifeMs: number, over: Record<string, unknown> = {}) {
  const made = b.createCard({
    thread_id: 'general',
    title: 'SECRET-TITLE send the contract',
    created_at: new Date(c.now()).toISOString(),
    expires_at: new Date(c.now() + lifeMs).toISOString(),
    ...over,
  })
  await waitFor(() => r.runtime.store.getCard(made.id) !== null, 3000, 'card stored')
  return made
}
const quietReply = async (r: TestRelay, b: FakeBridge, threadId: string, n = 1) => {
  const before = r.runtime.store.maxSeq()
  for (let i = 0; i < n; i++) b.reply(threadId, `private words ${i}`)
  await waitFor(() => r.runtime.store.maxSeq() >= before + n, 3000, 'replies stored')
  await sleep(30)
}

// ---------------------------------------------------------------------------------------------------------------------
describe('O2: card_expiring, one reminder about an hour before a card dies', () => {
  it('a 24 h card gets exactly one reminder inside its last hour, with fixed text and no card title', async () => {
    const c = fakeClock(utc7('08:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    const made = await card(r, b, c, 24 * HOUR)
    await gone(r, b)
    expect(reminders(r)).toHaveLength(0)
    await advance(c, 22 * HOUR, 5 * 60_000) // 06:00 next morning: 2 h left
    expect(reminders(r)).toHaveLength(0)
    await advance(c, 90 * 60_000, 5 * 60_000) // 07:30: 30 min left
    await waitFor(() => reminders(r).length === 1, 3000, 'the reminder')
    const p = reminders(r)[0]?.payload
    expect(p?.notification.body).toBe('A card in General expires soon')
    expect(p?.talos).toMatchObject({ kind: 'card', thread_id: 'general', card_id: made.id })
    expect(p?.notification.navigate).toBe(`/card/${made.id}`)
    expect(JSON.stringify(p)).not.toContain('SECRET-TITLE')
    // it was sent in the hour before expiry, not at once
    await advance(c, 20 * 60_000, 5 * 60_000)
    await sleep(40)
    expect(reminders(r)).toHaveLength(1) // once
    expect(r.runtime.store.getState(`card_reminded:${made.id}`)).toBe('sent')
  })

  it('a card that had under 2 h to live is not nagged about; one with exactly 2 h is', async () => {
    const c = fakeClock(utc7('08:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await card(r, b, c, 119 * 60_000, { title: 'Short one' })
    await gone(r, b)
    await advance(c, 118 * 60_000, 5 * 60_000) // 1 minute before it dies
    await sleep(40)
    expect(reminders(r)).toHaveLength(0)

    const c2 = fakeClock(utc7('08:00'))
    const r2 = await relayOn(c2)
    const b2 = await bridgeFor(r2)
    await applyConfig(r2, b2)
    await card(r2, b2, c2, 2 * HOUR)
    await gone(r2, b2)
    await advance(c2, 90 * 60_000, 5 * 60_000)
    await waitFor(() => reminders(r2).length === 1, 3000, 'the 2 h card is reminded')
  })

  it('a relay restart repeats nothing, and still reminds a card it had not reminded yet', async () => {
    const c = fakeClock(utc7('08:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await applyConfig(a, b)
    const made = await card(a, b, c, 24 * HOUR)
    const late = await card(a, b, c, 24 * HOUR, { title: 'Second card' })
    await gone(a, b)
    await advance(c, 22 * HOUR + 30 * 60_000, 5 * 60_000) // 06:30: both have 90 min left
    expect(reminders(a)).toHaveLength(0)
    // reminded once...
    await advance(c, 45 * 60_000, 5 * 60_000) // 07:15
    await waitFor(() => reminders(a).length === 2, 3000, 'both reminded')
    // ...then the relay restarts on the same volume
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    expect(r2.runtime.store.getState(`card_reminded:${made.id}`)).toBe('sent')
    expect(r2.runtime.store.getState(`card_reminded:${late.id}`)).toBe('sent')
    await advance(c2, 30 * 60_000, 5 * 60_000)
    await sleep(60)
    expect(reminders(r2)).toHaveLength(0) // the new relay sent nothing
  })

  it('a restart BEFORE the reminder is due does not lose it', async () => {
    const c = fakeClock(utc7('08:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await applyConfig(a, b)
    await card(a, b, c, 24 * HOUR)
    await gone(a, b)
    await advance(c, 10 * HOUR, 30 * 60_000)
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    await advance(c2, 13 * HOUR + 10 * 60_000, 5 * 60_000) // 07:10 next day
    await waitFor(() => reminders(r2).length === 1, 3000, 'reminded after the restart')
  })

  it('a card decided before the hour is not reminded, and its flag does not linger', async () => {
    const c = fakeClock(utc7('08:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    const made = await card(r, b, c, 24 * HOUR)
    await gone(r, b)
    r.runtime.store.setState(`card_reminded:${made.id}`, 'try:1') // a stale flag of the card
    r.runtime.store.setCardState(made.id, { state: 'resolved' })
    await advance(c, 23 * HOUR + 30 * 60_000, 5 * 60_000)
    await sleep(40)
    expect(reminders(r)).toHaveLength(0)
    expect(r.runtime.store.stateKeys('card_reminded:')).toEqual([]) // swept with the card
  })

  it('the quiet window holds it (quiet is not broken for a near-expiry card) and it is not sent late', async () => {
    const c = fakeClock(utc7('22:30'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    // made during quiet, dies at 03:30 (in quiet too): the reminder is due 02:30
    const made = await card(r, b, c, 5 * HOUR)
    await gone(r, b)
    await advance(c, 8 * HOUR, 10 * 60_000) // 06:30: well past its death
    await sleep(40)
    expect(reminders(r)).toHaveLength(0)
    expect(r.runtime.store.getState(`card_reminded:${made.id}`)).toBeNull()
  })

  it('a reminder held by quiet goes out when quiet ends, if the card still has time', async () => {
    const c = fakeClock(utc7('02:00', 1))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    // lives 3 h (until 05:00): the hour-before mark is 04:00, exactly when quiet ends
    await card(r, b, c, 3 * HOUR)
    await gone(r, b)
    await advance(c, 110 * 60_000, 5 * 60_000) // 03:50, still quiet, 70 min left
    expect(reminders(r)).toHaveLength(0)
    await advance(c, 20 * 60_000, 5 * 60_000) // 04:10, 50 min left, not quiet
    await waitFor(() => reminders(r).length === 1, 3000, 'reminder after quiet')
  })

  it('a card that dies inside the quiet window is reminded BEFORE the window starts, once, never in the dark', async () => {
    // Made at 22:00 (quiet) for a day: it dies at 22:00 tomorrow, which is quiet too, so the hour before is quiet. The
    // reminder has to go out before 20:30 tomorrow, while the owner can still hear it.
    const c = fakeClock(utc7('22:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    const made = await card(r, b, c, 24 * HOUR)
    await gone(r, b)
    await advance(c, 22 * HOUR - 30 * 60_000, 10 * 60_000) // 19:30 next day: still too early
    expect(reminders(r)).toHaveLength(0)
    await advance(c, 53 * 60_000, 2 * 60_000) // 20:23, seven minutes before quiet starts
    await waitFor(() => reminders(r).length === 1, 3000, 'the reminder before quiet')
    expect(reminders(r)[0]?.payload.talos).toMatchObject({ kind: 'card', card_id: made.id })
    await advance(c, 2 * HOUR + 30 * 60_000, 10 * 60_000) // past its death, deep in quiet
    await sleep(40)
    expect(reminders(r)).toHaveLength(1) // exactly once
    expect(r.runtime.store.getState(`card_reminded:${made.id}`)).toBeNull() // swept with the dead card, no leftover
  })

  it('a card that dies when it is not quiet keeps the plain hour-before rule', async () => {
    const c = fakeClock(utc7('09:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await card(r, b, c, 24 * HOUR) // dies 09:00 tomorrow
    await gone(r, b)
    await advance(c, 22 * HOUR, 10 * 60_000) // 07:00 tomorrow: two hours left
    expect(reminders(r)).toHaveLength(0)
    await advance(c, 70 * 60_000, 5 * 60_000) // 08:10
    await waitFor(() => reminders(r).length === 1, 3000, 'plain reminder')
  })

  it('the master switch and a thread set to off hold it; a thread set to needs-you-only still gets it', async () => {
    for (const [label, over, expected] of [
      ['master off', { notifications: { master: false, show_thread_names: 'fixed_only' as const } }, 0],
      ['thread off', { threads: [thread('general', { notify: 'off', order: 0 })] }, 0],
      ['needs you only', { threads: [thread('general', { notify: 'needs_you', order: 0 })] }, 1],
    ] as const) {
      const c = fakeClock(utc7('08:00'))
      const r = await relayOn(c)
      const b = await bridgeFor(r)
      await applyConfig(r, b, over as Partial<AgentConfigT>)
      await card(r, b, c, 24 * HOUR)
      await gone(r, b)
      await advance(c, 23 * HOUR + 15 * 60_000, 5 * 60_000)
      await sleep(40)
      expect(reminders(r), label).toHaveLength(expected)
    }
  })
})

describe('O2: the reminder is a needs-you push, not a chat reply', () => {
  it('a window someone is looking at swallows a reply but not card_expiring (a card waits on the owner)', async () => {
    const c = fakeClock(utc7('08:00'))
    const r = await relayOn(c)
    const web = new NoopTransport()
    const push = new CorePush({
      store: r.runtime.store,
      clock: c,
      log: r.relay.services.log,
      transport: web,
      config: () => cfgOf({ quiet_window: null }),
      anyVisible: () => true,
    })
    await push.notify({ template: 'reply', thread_id: 'general' })
    expect(web.sent).toHaveLength(0)
    await push.notify({
      template: 'card_expiring',
      thread_id: 'general',
      card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0',
      expires_at: new Date(c.now() + HOUR).toISOString(),
    })
    expect(web.sent).toHaveLength(1)
    expect(web.sent[0]?.payload.talos.kind).toBe('card')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('O7: one wake-up summary after the quiet window', () => {
  it('3 replies and a waiting card during quiet: nothing then, ONE summary at 04:00, never again', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 3)
    await card(r, b, c, 24 * HOUR)
    await sleep(30)
    expect(sent(r)).toHaveLength(0) // quiet held the replies and the card
    expect(readQuietHeld(r.runtime.store)).toMatchObject({ replies: 3 })
    await gone(r, b)
    await advance(c, 6 * HOUR + 30 * 60_000, 10 * 60_000) // 03:30, still quiet
    expect(summaries(r)).toHaveLength(0)
    await advance(c, 45 * 60_000, 5 * 60_000) // 04:15
    await waitFor(() => summaries(r).length === 1, 3000, 'the summary')
    const p = summaries(r)[0]?.payload
    expect(p?.notification.body).toBe('3 replies, 1 card waiting')
    expect(everything(r)).not.toContain('private words')
    expect(everything(r)).not.toContain('SECRET-TITLE')
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
    await advance(c, 24 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(1) // no double send
  })

  it('a relay restart in the middle of the night keeps the counts and still sends exactly one summary', async () => {
    const c = fakeClock(utc7('21:00'))
    const a = await relayOn(c)
    const b = await bridgeFor(a)
    await applyConfig(a, b)
    await quietReply(a, b, 'general', 2)
    await gone(a, b)
    await advance(c, 3 * HOUR, 30 * 60_000) // 00:00
    const dir = a.dir
    const key = a.bridgeKey
    await a.stopKeepData()
    relays.splice(relays.indexOf(a), 1)
    const c2 = fakeClock(new Date(c.now()).toISOString())
    const r2 = await relayOn(c2, { dir, bridgeKey: key })
    expect(readQuietHeld(r2.runtime.store).replies).toBe(2)
    await advance(c2, 4 * HOUR + 15 * 60_000, 15 * 60_000) // 04:15
    await waitFor(() => summaries(r2).length === 1, 3000, 'the summary after the restart')
    expect(summaries(r2)[0]?.payload.notification.body).toBe('2 replies')
    // and a restart AFTER the summary sends nothing more
    const dir2 = r2.dir
    await r2.stopKeepData()
    relays.splice(relays.indexOf(r2), 1)
    const c3 = fakeClock(new Date(c2.now()).toISOString())
    const r3 = await relayOn(c3, { dir: dir2, bridgeKey: key })
    await advance(c3, 2 * HOUR, 10 * 60_000)
    await sleep(40)
    expect(summaries(r3)).toHaveLength(0)
  })

  it('quiet off: replies push straight away, nothing is held, no summary ever', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b, { quiet_window: null })
    await quietReply(r, b, 'general', 2)
    await waitFor(() => replyPushes(r).length === 2, 3000, 'two reply pushes')
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
    await gone(r, b)
    await advance(c, 12 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
  })

  it('removing the quiet window while things are held sends the summary at once instead of waiting for 04:00', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 1)
    await applyConfig(r, b, { quiet_window: null })
    c.advance(61_000)
    await waitFor(() => summaries(r).length === 1, 3000, 'summary after the window was removed')
    expect(summaries(r)[0]?.payload.notification.body).toBe('1 reply')
  })

  it('the master switch off sends nothing and drops the counts', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 2)
    await applyConfig(r, b, { notifications: { master: false, show_thread_names: 'fixed_only' } })
    await gone(r, b)
    await advance(c, 8 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
    expect(readQuietHeld(r.runtime.store).replies).toBe(0)
    // switching it back on later does not resurrect last night
    const b2 = await bridgeFor(r)
    await applyConfig(r, b2)
    await advance(c, 2 * HOUR, 30 * 60_000)
    expect(summaries(r)).toHaveLength(0)
  })

  it('a thread set to off is not counted; a thread set to needs-you-only counts cards but not replies', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b, {
      threads: [
        thread('general', { order: 0 }),
        thread('muted', { notify: 'off' }),
        thread('cardsonly', { notify: 'needs_you' }),
      ],
    })
    await quietReply(r, b, 'general', 1)
    await quietReply(r, b, 'muted', 3)
    await quietReply(r, b, 'cardsonly', 2)
    await card(r, b, c, 24 * HOUR, { thread_id: 'muted' })
    await card(r, b, c, 24 * HOUR, { thread_id: 'cardsonly' })
    await gone(r, b)
    await advance(c, 7 * HOUR + 30 * 60_000, 15 * 60_000)
    await waitFor(() => summaries(r).length === 1, 3000, 'the summary')
    expect(summaries(r)[0]?.payload.notification.body).toBe('1 reply, 1 card waiting')
  })

  it('a card decided during the night is not "waiting"; with nothing else to say nothing is sent', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    const made = await card(r, b, c, 24 * HOUR)
    expect(readQuietHeld(r.runtime.store).cards).toEqual([made.id])
    r.runtime.store.setCardState(made.id, { state: 'resolved' })
    await gone(r, b)
    await advance(c, 8 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
  })

  it('an empty night sends nothing', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await gone(r, b)
    await advance(c, 9 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
  })

  it('does not overlap the hooks digest: an "overnight" push held by quiet is not counted, and holds nothing', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await r.relay.services.push.notify({ template: 'overnight', count: 7 })
    await r.relay.services.push.notify({ template: 'schedule_failed' })
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
    await gone(r, b)
    await advance(c, 8 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
  })

  it('replies the owner read before the window ended are not "waiting"; the ones still unread are', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 3)
    expect(readQuietHeld(r.runtime.store)).toMatchObject({ replies: 3, by: { general: 3 } })
    // read on another device: everything so far
    r.runtime.store.setRead('general', r.runtime.store.maxSeq())
    await quietReply(r, b, 'general', 1) // one more arrives after, still unread
    await gone(r, b)
    await advance(c, 7 * HOUR + 30 * 60_000, 10 * 60_000) // 04:30
    await waitFor(() => summaries(r).length === 1, 3000, 'the summary')
    expect(summaries(r)[0]?.payload.notification.body).toBe('1 reply')
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
  })

  it('everything read before the window ended: no summary at all, no push, no leftover count', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 3)
    await gone(r, b)
    r.runtime.store.setRead('general', r.runtime.store.maxSeq())
    await advance(c, 8 * HOUR, 30 * 60_000)
    await sleep(40)
    expect(summaries(r)).toHaveLength(0)
    expect(replyPushes(r)).toHaveLength(0)
    expect(sent(r).filter((x) => x.payload.talos.kind !== 'system')).toHaveLength(0) // (a "Mac session stopped" is not ours)
    expect(readQuietHeld(r.runtime.store)).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
  })

  it('a thread turned off, or to needs-you-only, during the night is not told about in the morning', async () => {
    for (const notify of ['off', 'needs_you'] as const) {
      const c = fakeClock(utc7('21:00'))
      const r = await relayOn(c)
      const b = await bridgeFor(r)
      await applyConfig(r, b)
      await quietReply(r, b, 'general', 2)
      await applyConfig(r, b, { threads: [thread('general', { notify, order: 0 })] })
      await gone(r, b)
      await advance(c, 7 * HOUR + 30 * 60_000, 10 * 60_000)
      await sleep(40)
      expect(summaries(r), notify).toHaveLength(0)
      expect(readQuietHeld(r.runtime.store), notify).toEqual({ replies: 0, by: {}, cards: [], tries: 0 })
    }
  })

  it('state saved before replies were split per thread is still read, and still told', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    r.runtime.store.setState('quiet_held', JSON.stringify({ replies: 2, cards: [], tries: 0 })) // the old shape
    await gone(r, b)
    await advance(c, 7 * HOUR + 30 * 60_000, 10 * 60_000)
    await waitFor(() => summaries(r).length === 1, 3000, 'the summary')
    expect(summaries(r)[0]?.payload.notification.body).toBe('2 replies')
  })

  it('a push service that refuses every push is retried a few times, then dropped; it never floods', async () => {
    const c = fakeClock(utc7('21:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b)
    await quietReply(r, b, 'general', 1)
    await gone(r, b)
    const send = vi.spyOn(r.transport, 'send').mockResolvedValue({ ok: false, gone: false })
    await advance(c, 7 * HOUR + 10 * 60_000, 5 * 60_000) // past 04:00
    await advance(c, 30 * 60_000, 60_000)
    await sleep(60)
    const attempts = send.mock.calls.filter((a) => a[1].talos.kind === 'digest').length
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(attempts).toBeLessThanOrEqual(5)
    expect(readQuietHeld(r.runtime.store).replies).toBe(0) // given up on
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('O21: the badge in a push is open cards + unread, minus archived and notify-off threads', () => {
  it('counts both, in the push the relay really sends', async () => {
    const c = fakeClock(utc7('08:00'))
    const r = await relayOn(c)
    const b = await bridgeFor(r)
    await applyConfig(r, b, {
      quiet_window: null,
      threads: [thread('general', { order: 0 }), thread('muted', { notify: 'off' }), thread('old', { archived: true })],
    })
    await quietReply(r, b, 'muted', 5) // off: pushes nothing, counts nothing
    expect(sent(r)).toHaveLength(0)
    await quietReply(r, b, 'old', 4) // archived: still pushes (unchanged), but its unread counts nothing
    await waitFor(() => replyPushes(r).length === 4, 3000, 'pushes for the archived thread')
    expect(replyPushes(r).map((s) => s.payload.notification.app_badge)).toEqual([0, 0, 0, 0])
    await quietReply(r, b, 'general', 2)
    await waitFor(() => replyPushes(r).length === 6, 3000, 'reply pushes')
    expect(replyPushes(r).at(-1)?.payload.notification.app_badge).toBe(2) // 2 unread
    await card(r, b, c, 24 * HOUR) // an open card on top
    await card(r, b, c, 24 * HOUR, { thread_id: 'muted' }) // a card in an off thread: not pushed, but it IS counted
    await card(r, b, c, 24 * HOUR, { thread_id: 'old' }) // a card in an archived thread: pushed, and counted
    await waitFor(() => sent(r).filter((s) => s.payload.talos.kind === 'card').length === 2, 3000, 'card pushes')
    const cardPushes = sent(r).filter((s) => s.payload.talos.kind === 'card')
    expect(cardPushes[0]?.payload.notification.app_badge).toBe(3) // 2 unread + the one card in General
    // A card waits on the owner whatever its thread says: the push that announces the archived thread's card must not
    // leave that card out of the number (at 0 the service worker would CLEAR the icon).
    expect(cardPushes[1]?.payload.notification.app_badge).toBe(5) // 2 unread + 3 open cards
  })

  it('badgeCount: cards are never left out for their thread; expired and decided ones are; unread leaves out off and archived', () => {
    const now = Date.parse('2026-10-31T15:00:00Z')
    const card = (thread_id: string, state = 'pending', expires_at = '2026-10-31T16:00:00Z') => ({
      thread_id,
      state,
      expires_at,
    })
    const threads = [
      { id: 'a' },
      { id: 'off', notify: 'off' },
      { id: 'gone', archived: true },
      { id: 'ny', notify: 'needs_you' },
    ]
    expect(
      badgeCount(
        {
          cards: [
            card('a'),
            card('a', 'resolved'),
            card('a', 'pending', '2026-10-31T14:59:59Z'),
            card('off'),
            card('gone'),
            card('ny'),
            card('unknown'),
          ],
          unread: { a: 2, off: 9, gone: 9, ny: 1, unknown: 3, z: 0, neg: -4 },
          threads,
        },
        now,
      ),
    ).toBe(5 /* open cards: a, off, gone, ny, unknown */ + 6 /* unread: a 2, ny 1, unknown 3 */)
    expect(badgeCount({ cards: [], unread: {}, threads: [] }, now)).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe('the new templates are fixed text', () => {
  it('quiet_summary: counts only, whole numbers, plural words', () => {
    expect(quietSummaryBody(3, 1)).toBe('3 replies, 1 card waiting')
    expect(quietSummaryBody(1, 2)).toBe('1 reply, 2 cards waiting')
    expect(quietSummaryBody(0, 1)).toBe('1 card waiting')
    expect(quietSummaryBody(2, 0)).toBe('2 replies')
    expect(quietSummaryBody(0, 0)).toBe('Nothing new')
    expect(quietSummaryBody(-3, Number.NaN)).toBe('Nothing new')
    expect(quietSummaryBody(2.9, undefined)).toBe('2 replies')
    // a string smuggled in through a cast is a number or nothing, never text
    expect(quietSummaryBody('<b>x</b>' as unknown as number, 1)).toBe('1 card waiting')
  })

  it('the wake-up summary keeps 12 h at the push service, not 1 h; a plain reply still 1 h, a card 24 h', () => {
    const cfg = DEFAULT_AGENT_CONFIG
    const sum = buildPushPayload({ template: 'quiet_summary', replies: 3, cards: 1 }, cfg)
    const reply = buildPushPayload({ template: 'reply', thread_id: 'general' }, cfg)
    const card = buildPushPayload({ template: 'needs_you', thread_id: 'general' }, cfg)
    expect(pushTtlSeconds(sum)).toBe(PUSH_TTL_S.digest)
    expect(PUSH_TTL_S.digest).toBeGreaterThanOrEqual(12 * 3600)
    expect(pushTtlSeconds(reply)).toBe(PUSH_TTL_S.normal)
    expect(pushTtlSeconds(card)).toBe(PUSH_TTL_S.card)
  })

  it('only the reminder asks to alert again over its card banner (it shares the card tag); needs_you does not', () => {
    const cfg = DEFAULT_AGENT_CONFIG
    const ids = { thread_id: 'general', card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0' }
    const exp = buildPushPayload({ template: 'card_expiring', ...ids }, cfg)
    const need = buildPushPayload({ template: 'needs_you', ...ids }, cfg)
    expect(exp.notification.tag).toBe(need.notification.tag)
    expect(exp.notification.renotify).toBe(true)
    expect(need.notification.renotify).toBeUndefined()
  })

  it('card_expiring and quiet_summary carry no title and no free text, whatever the intent says', () => {
    const cfg = DEFAULT_AGENT_CONFIG
    const evil = { title: 'SECRET', text: 'SECRET', name: 'SECRET' }
    const exp = buildPushPayload(
      { template: 'card_expiring', thread_id: 'general', card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0', ...evil } as never,
      cfg,
    )
    const sum = buildPushPayload({ template: 'quiet_summary', replies: 3, cards: 1, ...evil } as never, cfg)
    expect(JSON.stringify([exp, sum])).not.toContain('SECRET')
    expect(exp.talos.kind).toBe('card')
    expect(exp.notification.body).toBe('A card in General expires soon')
    expect(sum.notification.body).toBe('3 replies, 1 card waiting')
    expect(sum.notification.navigate).toBe('/')
  })
})
