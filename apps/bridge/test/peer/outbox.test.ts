// The sender loop: a durable outbox, the same id on every try, a fresh timestamp each time, and what each answer means.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { type CardT, PEER_RETRY_HOURS } from '@talos-app/protocol'
import { fakeClock, sleep, t, waitFor } from '@talos-app/testkit'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { createLogger } from '../../src/log.ts'
import { PeerService } from '../../src/peer/service.ts'
import { HARNESS_START_MS } from '../helpers.ts'
import { type Install, install, linkBoth, memorySecrets, rowsOf, text } from './helpers.ts'

// two installs start (the harness's own waits) before a test's own waits begin
setDefaultTimeout(t(30_000))

let a: Install | undefined
let b: Install | undefined
let extra: Bridge | undefined
afterEach(async () => {
  await extra?.stop()
  await a?.stop()
  await b?.stop()
  a = b = extra = undefined
})

async function pair() {
  a = await install({ to: () => b })
  b = await install({ to: () => a })
  await linkBoth(a, b)
  return { a, b }
}
const send = (h: Install, args: Record<string, unknown> = {}) =>
  h.bridge.callTool('peer_send', { peer: 'work', text: 'a message', label: 'TASK', ...args })

const askCards = (h: Install) =>
  h.relay.frames
    .filter((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')
    .map((f) => f.raw.card as CardT)
    .filter((c) => (c.payload as { peer_address?: unknown } | undefined)?.peer_address !== undefined)
const moveLink = (h: Install, url: string) =>
  h.bridge.ctx.config.update((c) => ({ ...c, peers: c.peers.map((p) => (p.name === 'work' ? { ...p, url } : p)) }))
const linkOf = (h: Install) => h.bridge.ctx.config.config.peers.find((p) => p.name === 'work')?.url as string
const outboxRows = (h: Install) =>
  h.bridge.ctx.store.db.query('SELECT state, detail, url FROM peer_outbox ORDER BY created_at').all() as Array<{
    state: string
    detail: string | null
    url: string | null
  }>

describe('the address behind a name changes while a message waits (T32)', () => {
  /** A message that could not go (503), then the link is moved to another address. */
  async function waiting() {
    const { a, b } = await pair()
    b.relay.peers.refuse = { status: 503, error: 'unavailable' }
    await send(a)
    await waitFor(() => a.calls.length === 1, 4000, 'first try')
    const old = linkOf(a)
    const moved = `${old}?moved=1`
    moveLink(a, moved)
    b.relay.peers.refuse = null
    a.clock.advance(60_000)
    return { a, b, old, moved }
  }

  test(
    'the message is held, not sent to the new address, and one card asks the owner; later ticks ask nothing more',
    async () => {
      const { a } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      expect(a.calls).toHaveLength(1) // only the first try, to the old address
      const card = askCards(a)[0] as CardT
      expect(card.kind).toBe('config')
      expect(card.title).toBe('work has a new address')
      expect(card.body).toContain('A message is waiting')
      for (let i = 0; i < 3; i++) {
        a.clock.advance(31 * 60_000)
        await sleep(t(100)) // timing-ok: negative window, from the clock moved past the re-check (the timer is due): still one ask, nothing sent
      }
      expect(askCards(a)).toHaveLength(1)
      expect(a.calls).toHaveLength(1)
      expect(outboxRows(a)[0]?.state).toBe('pending')
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'a yes in the app sends it to the new address, once',
    async () => {
      const { a, b, moved } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      const card = askCards(a)[0] as CardT
      await a.app.resolveCard(card, 'primary', card.payload_hash)
      await waitFor(() => a.calls.length === 2, 4000, 'the send after the yes')
      expect(a.calls[1]?.status).toBe(200)
      await waitFor(() => b.peerNotes().length === 1, 4000, 'landed')
      expect(outboxRows(a)[0]).toMatchObject({ state: 'sent', url: moved })
      await a.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', { direction: 'in' })
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'a no refuses it and it never goes',
    async () => {
      const { a } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      const card = askCards(a)[0] as CardT
      await a.app.resolveCard(card, 'kill', card.payload_hash)
      await waitFor(() => outboxRows(a)[0]?.state === 'refused', 4000, 'refused')
      expect(outboxRows(a)[0]?.detail).toBe('address_changed')
      a.clock.advance(3 * 3600_000)
      await sleep(t(200)) // timing-ok: negative window, from the refusal stored and the clock moved 3 h: nothing is sent
      expect(a.calls).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'a yes is not honoured when the address changed again since the card: nothing is sent',
    async () => {
      const { a, old } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      const card = askCards(a)[0] as CardT
      moveLink(a, `${old}?moved=2`)
      await a.app.resolveCard(card, 'primary', card.payload_hash)
      await a.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', { direction: 'in' })
      expect(a.calls).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'link A, a typo B, fixed to C: a No on the question about B does not refuse the messages written for C; the question about C still sends them',
    async () => {
      const { a, b, old } = await waiting() // the message was written for A; the link is now B and the question about B is up
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask about B')
      const cardB = askCards(a)[0] as CardT
      const fixed = `${old}?fixed=1`
      moveLink(a, fixed) // C
      a.clock.advance(31 * 60_000) // the held message is looked at again: a question about C
      b.clock.advance(31 * 60_000) // the other install's clock keeps up, or its relay refuses the signed time
      await waitFor(() => askCards(a).length === 2, 4000, 'the ask about C')
      await a.app.resolveCard(cardB, 'kill', cardB.payload_hash)
      await a.app.expectFrame('card.update', (u) => u.card_id === cardB.id && u.state === 'done', { direction: 'in' })
      expect(outboxRows(a)[0]?.state).toBe('pending') // not refused
      expect(a.calls).toHaveLength(1)
      const cardC = askCards(a)[1] as CardT
      await a.app.resolveCard(cardC, 'primary', cardC.payload_hash)
      await waitFor(() => a.calls.length === 2, 4000, 'the send after the yes about C')
      expect(outboxRows(a)[0]).toMatchObject({ state: 'sent', url: fixed })
    },
    HARNESS_START_MS * 2 + t(60_000),
  )

  test(
    'a yes after the messages gave up says so and sends nothing',
    async () => {
      const { a } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      const card = askCards(a)[0] as CardT
      a.bridge.ctx.store.db.query("UPDATE peer_outbox SET state = 'gave_up'").run()
      await a.app.resolveCard(card, 'primary', card.payload_hash)
      const done = await a.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
        direction: 'in',
      })
      expect(done.result?.text).toContain('gave up')
      expect(a.calls).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'a held message that is never answered gives up after the retry window, with the code in the row',
    async () => {
      const { a } = await waiting()
      await waitFor(() => askCards(a).length === 1, 4000, 'the ask')
      for (let i = 0; i < 60 && !rowsOf(a).some((x) => x.includes('Gave up sending')); i++) {
        a.clock.advance(31 * 60_000)
        await sleep(t(50)) // timing-ok: lets the due timer run its attempt before the clock moves again
      }
      expect(rowsOf(a).some((x) => x.includes('address_changed'))).toBe(true)
      expect(a.calls).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(120_000),
  )

  test(
    'a message queued before addresses were kept goes to whatever is linked now, as it always did',
    async () => {
      const { a, b } = await pair()
      b.relay.peers.refuse = { status: 503, error: 'unavailable' }
      await send(a)
      await waitFor(() => a.calls.length === 1, 4000, 'first try')
      a.bridge.ctx.store.db.query('UPDATE peer_outbox SET url = NULL').run()
      moveLink(a, `${linkOf(a)}?moved=1`)
      b.relay.peers.refuse = null
      a.clock.advance(60_000)
      await waitFor(() => a.calls.length === 2, 4000, 'the second try')
      expect(askCards(a)).toHaveLength(0)
    },
    HARNESS_START_MS * 2 + t(40_000),
  )
})

describe('the sender loop', () => {
  test(
    'a 5xx is retried with the same id and a fresh timestamp, and then lands once',
    async () => {
      const { a, b } = await pair()
      b.relay.peers.refuse = { status: 503, error: 'unavailable' }
      await send(a)
      await waitFor(() => a.calls.length === 1, 4000, 'first try')
      expect(a.calls[0]?.status).toBe(503)
      b.relay.peers.refuse = null
      a.clock.advance(20_000)
      await waitFor(() => a.calls.length === 2, 4000, 'second try')
      expect(a.calls[1]?.id).toBe(a.calls[0]?.id)
      expect(a.calls[1]?.status).toBe(200)
      expect(Number(a.calls[1]?.ts)).toBeGreaterThan(Number(a.calls[0]?.ts))
      await waitFor(() => b.peerNotes().length === 1, 4000, 'landed')
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'another 4xx stops with a row naming the code, and is not retried',
    async () => {
      const { a, b } = await pair()
      b.relay.peers.refuse = { status: 400, error: 'bad_body' }
      await send(a)
      await waitFor(() => rowsOf(a).some((t) => t.includes('refused a message (bad_body)')), 4000, 'the row')
      a.clock.advance(3 * 3600_000)
      await sleep(t(200)) // timing-ok: negative window, from the refusal row seen and the clock moved 3 h (every retry timer due): no retry
      expect(a.calls).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test(
    'after the retry window it gives up with a row',
    async () => {
      const { a, b } = await pair()
      b.relay.peers.refuse = { status: 503, error: 'unavailable' }
      await send(a)
      await waitFor(() => a.calls.length === 1, 4000, 'first')
      let n = 1
      for (let i = 0; i < 60 && !rowsOf(a).some((t) => t.includes('Gave up sending')); i++) {
        a.clock.advance(31 * 60_000)
        await waitFor(() => a.calls.length > n || rowsOf(a).some((t) => t.includes('Gave up')), 4000, 'a try').catch(
          () => {},
        )
        n = a.calls.length
      }
      expect(
        rowsOf(a).some((t) => t.includes(`Gave up sending a message to work after ${PEER_RETRY_HOURS} hours`)),
      ).toBe(true)
      const before = a.calls.length
      a.clock.advance(5 * 3600_000)
      await sleep(t(200)) // timing-ok: negative window, from the give-up row seen and the clock moved 5 h: no further try
      expect(a.calls).toHaveLength(before)
    },
    HARNESS_START_MS * 2 + t(120_000),
  )

  test(
    'the outbox survives a restart, and the retry keeps the same id',
    async () => {
      const { a, b } = await pair()
      b.relay.peers.refuse = { status: 503, error: 'unavailable' }
      await send(a)
      await waitFor(() => a.calls.length === 1, 4000, 'first')
      const id = a.calls[0]?.id
      await a.bridge.stop() // the Mac restarts
      b.relay.peers.refuse = null
      const calls: Array<{ id: string }> = []
      extra = await Bridge.create({
        env: loadEnv({ TALOS_APP_HOME: a.home, TALOS_APP_RELAY_URL: a.relay.httpUrl, TALOS_APP_BRIDGE: '1' }),
        logger: createLogger(null, 'error', () => {}),
        peers: {
          secrets: a.secrets,
          clock: a.clock,
          fetch: async (url, init) => {
            calls.push({ id: String((init.headers as Record<string, string>)['webhook-id']) })
            return fetch(`${b?.relay.httpUrl}${new URL(url).pathname}`, init as RequestInit)
          },
        },
      })
      extra.start()
      a.clock.advance(60_000)
      await waitFor(() => calls.length === 1, 4000, 'the retry after the restart')
      expect(calls[0]?.id).toBe(id as string)
      await waitFor(() => (b as Install).peerNotes().length === 1, 4000, 'landed')
    },
    HARNESS_START_MS * 2 + t(40_000),
  )

  test(
    'an address Talos will not contact is refused at once, not retried',
    async () => {
      a = await install()
      b = await install()
      await linkBoth(a, b)
      a.bridge.ctx.config.update((c) => ({
        ...c,
        peers: [{ name: 'work', url: 'https://127.0.0.1:9/hook/peer/cn_x', daily_cap: 50 }],
      }))
      const svc = new PeerService(a.bridge.ctx, { secrets: a.secrets, clock: a.clock }) // the real guarded fetch
      const r = await svc.send({ peer: 'work', text: 'hello' })
      expect(r.ok).toBe(true)
      await waitFor(() => rowsOf(a as Install).some((t) => t.includes('one Talos will not contact')), 4000, 'the row')
      svc.stop()
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test(
    'log lines never carry the text or the secret',
    async () => {
      const lines: string[] = []
      a = await install({ to: () => b })
      b = await install({ to: () => a })
      await linkBoth(a, b)
      const ctx = a.bridge.ctx
      for (const level of ['info', 'warn', 'error'] as const) {
        const orig = ctx.log[level].bind(ctx.log)
        ctx.log[level] = ((m: string, f?: Record<string, unknown>) => {
          lines.push(`${m} ${JSON.stringify(f ?? {})}`)
          return orig(m, f)
        }) as never
      }
      b.relay.peers.refuse = { status: 503, error: 'unavailable' }
      const secretText = 'the plan involves the blue folder and the tall ladder'
      await send(a, { text: secretText })
      await waitFor(() => a?.calls.length === 1, 4000, 'try')
      const secret = [...a.secrets.data.values()][0] as string
      for (const l of lines) {
        expect(l).not.toContain(secretText)
        expect(l).not.toContain(secret)
      }
      void fakeClock
      void memorySecrets
      void text
    },
    HARNESS_START_MS * 2 + t(30_000),
  )
})
