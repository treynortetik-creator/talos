// BUGHUNT (web push): one push endpoint that accepts the request and never answers stops the card reminders (and the
// quiet summary, which has the same shape) for the rest of the process' life.
//  - `createWebPushTransport` passes no `timeout` to web-push (src/core/push.ts:52-57), and web-push sets a socket timeout
//    only when one is given, so a send to a stalled endpoint never settles. APNs has its own 10 s deadline; web push none.
//  - `CorePush.deliver` awaits every send (src/core/push.ts:451-462), `CardReminder.scan` awaits `notifyCounted` inside its
//    loop (src/core/card-reminder.ts:124) and `tick` holds `busy` until scan returns (src/core/card-reminder.ts:84-94).
// After one such send every later tick returns at `if (this.busy)`: no card gets its "expires soon" push again, silently.
// The hub's own pushes are fire-and-forget, so they only leak a promise each; `POST /api/push/test` hangs the same way.
// Suggested fix: a deadline around each transport send (and `timeout` in the web-push options).
import { buildCard, fakeClock, mkFrame, t as scaled, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { CardReminder, REMIND_LEAD_MS, REMINDER_TICK_MS } from '../../src/core/card-reminder.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { silentBridge, sub } from '../core/helpers.ts'

// Scaled like every wait inside (TALOS_TEST_TIME_FACTOR, 3 on a small Mac): a fixed 60 s here once ended the test before a
// stuck wait (30 s each at factor 3) could say which one it was, leaving only "timed out" (2026-11-13, load 12).
vi.setConfig({ testTimeout: scaled(60_000) })
let relay: TestRelay | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await relay?.stop()
  relay = null
})

/**
 * Counts the card reminder's looks that did their work (one that starts while the last is still running returns at once and
 * is not counted). Set before the relay starts, so it wraps the runtime's reminder.
 */
function countReminderLooks() {
  const done = { n: 0 }
  const real = CardReminder.prototype.tick
  vi.spyOn(CardReminder.prototype, 'tick').mockImplementation(async function (this: CardReminder) {
    const ran = !(this as unknown as { busy: boolean }).busy
    await real.call(this)
    if (ran) done.n++
  })
  return done
}

/**
 * Moves the fake clock one reminder tick at a time until `cond`, each step only after the look it started has finished.
 * A fixed real-time pause per step left a look unfinished on a loaded machine, so the next tick found it busy and was skipped,
 * and the reminder could run out of steps. Bounded in fake time (`maxTicks`); the real wait per step is a hang cap only.
 * `settle` runs after each step (the bridge's ping barrier while it is connected: see `bridgeAlive`).
 */
async function tickUntil(
  c: ReturnType<typeof fakeClock>,
  looks: { n: number },
  cond: () => boolean,
  maxTicks: number,
  what: string,
  settle: () => Promise<void> = async () => {},
) {
  for (let i = 0; i < maxTicks && !cond(); i++) {
    const before = looks.n
    c.advance(REMINDER_TICK_MS)
    await waitFor(() => looks.n > before || cond(), 10_000, 'the reminder look for this tick')
    await settle()
  }
  if (!cond()) throw new Error(`${what}: not reached within ${maxTicks} reminder ticks`)
}

/** Moves the fake clock in steps, `settle` between them (a real-time pause by default), until `cond`. */
async function pumpUntil(
  c: ReturnType<typeof fakeClock>,
  cond: () => boolean,
  maxSteps: number,
  what: string,
  stepMs: number,
  settle: () => Promise<void> = () => new Promise((res) => setTimeout(res, 25)),
) {
  for (let i = 0; i < maxSteps && !cond(); i++) {
    c.advance(stepMs)
    await settle()
  }
  if (!cond()) throw new Error(`${what}: not reached within ${maxSteps} steps of ${stepMs / 1000} fake seconds`)
}

it('a push service that never answers one send does not end card reminders for good', async () => {
  const looks = countReminderLooks()
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const r = relay
  r.runtime.store.putSub(sub(1))
  const b = await silentBridge(r, r.bridgeKey)
  const at = (ms: number) => new Date(c.now() + ms).toISOString()
  const hour = 3_600_000
  const cardSends = (id: string) => r.transport.sent.filter((s) => s.payload.talos.card_id === id).length

  const first = buildCard({ thread_id: 'general', created_at: at(0), expires_at: at(3 * hour) })
  b.send(mkFrame('card.create', { card: first }))
  await waitFor(() => cardSends(first.id) === 1, 10_000, 'the needs-you push for the first card')

  // The push service stalls on the next request: the connection is accepted and nothing ever comes back.
  const real = r.transport.send.bind(r.transport)
  let stalled = 0
  r.transport.send = (...args: Parameters<typeof real>) => {
    stalled++
    r.transport.send = real // only this one request hangs; the service is fine again afterwards
    void args
    return new Promise(() => {})
  }
  // The relay pings the bridge every 25 fake seconds and drops it once 75 have passed with nothing from it, so two 60 s steps
  // with no answer in between end it. A fixed real-time pause per step let a loaded machine miss the pong; the second card
  // then went to a dead socket and the test hung. Instead each step waits for the bridge's own ping to come back: the relay
  // has heard from it at this fake time, whatever the load.
  const bridgeAlive = async () => {
    await b.sync()
    if (b.closeCode !== null) throw new Error(`the relay dropped the bridge (${b.closeCode}) while the clock moved`)
  }
  // the first card's reminder comes due (an hour before it expires) and is sent into the stall. Nothing happens before it, so
  // the clock gets there quickly; the last minutes go one tick at a time.
  await pumpUntil(
    c,
    () => c.now() >= Date.parse(first.expires_at) - REMIND_LEAD_MS - 3 * 60_000,
    200,
    'near the first reminder',
    60_000,
    bridgeAlive,
  )
  await tickUntil(c, looks, () => stalled === 1, 30, 'the stalled reminder', bridgeAlive)

  const second = buildCard({ thread_id: 'general', created_at: at(0), expires_at: at(3 * hour) })
  b.send(mkFrame('card.create', { card: second }))
  await waitFor(() => cardSends(second.id) === 1, 30_000, 'the needs-you push for the second card')
  await b.close()
  // its reminder comes due; the push service has long been healthy again. Before the fix it never came: the reminder loop
  // was still waiting on the first send. No socket is left to keep alive and nothing is due before it, so no real pause either.
  await pumpUntil(
    c,
    () => c.now() >= Date.parse(second.expires_at) - REMIND_LEAD_MS - 3 * 60_000,
    200,
    'near the second reminder',
    60_000,
    () => new Promise((res) => setImmediate(res)),
  )
  await tickUntil(c, looks, () => cardSends(second.id) === 2, 30, "the second card's reminder")
  expect(cardSends(second.id)).toBe(2)
})

it('the Settings "send a test" call answers 502 when the push service never answers, instead of hanging', async () => {
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const r = relay
  r.runtime.store.putSub(sub(1))
  r.transport.send = () => new Promise(() => {})
  const pending = fetch(`${r.httpBase}/api/push/test`, {
    method: 'POST',
    headers: {
      'X-Test-Session': 'none',
      Origin: 'https://relay.example.com',
      'X-Talos-CSRF': '1',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  let status = 0
  void pending.then((res) => {
    status = res.status
  })
  await new Promise((res) => setTimeout(res, 100)) // the send is under way
  // past the send deadline, however late the request reached the relay
  await pumpUntil(c, () => status !== 0, 60, 'the test call answered', 5_000)
  expect(status).toBe(502)
})
