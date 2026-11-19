// BYOR phase 4: POST /api/bridge/attest. The relay hands a phone's nonce to the live Mac and gives its answer back; it never
// checks the signature (the phone does). Public, no csrf, never cached, rate limited by address and relay-wide, a paired
// phone's cookie moves it to a roomier bucket without any side effect.
import { ATTEST_FEATURE, signChallenge } from '@talos-app/protocol'
import { type FakeClock, fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { testAppHeaders } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'

const PATH = '/api/bridge/attest'
const NONCE = 'A'.repeat(43)
const PUBKEY = 'B'.repeat(43)
const SIG = 'C'.repeat(86)
const CERT = { relay_id: 'r_abcdefghijklmnopqrst', old_pubkey: PUBKEY, new_pubkey: PUBKEY, sig: SIG }

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

type Fake = { sent: Array<Record<string, unknown>>; say(frame: Record<string, unknown>): void; closed: number[] }

/** A bridge socket the test drives by hand: it records what the relay sends and says only what the test says. */
async function bridgeUp(r: TestRelay, clock: FakeClock, features: string[]): Promise<Fake> {
  const sent: Array<Record<string, unknown>> = []
  const closed: number[] = []
  const sock = r.runtime.hub.attachBridge(
    {
      send: (t: string) => void sent.push(JSON.parse(t)),
      close: (c: number) => void closed.push(c),
      terminate: () => {},
    },
    { ip: '198.51.100.5', relayHost: 'relay.example.com' },
  )
  sock.onMessage(
    JSON.stringify({
      v: 1,
      type: 'hello',
      id: '01JBF3V7Q8K2M4N6P8R0S2T41M',
      ts: new Date(clock.now()).toISOString(),
      role: 'bridge',
      key_id: r.bridgeKey.keyId,
      sig: await signChallenge(r.bridgeKey.privateKey, sent[0] as never),
      client: { name: 'bridge', version: '1', features },
      agent_config_rev: 0,
    }),
  )
  await waitFor(() => sent.some((f) => f.type === 'ready'), 4000, 'ready')
  return {
    sent,
    closed,
    say: (f) =>
      void sock.onMessage(
        JSON.stringify({ v: 1, id: '01JBF3V7Q8K2M4N6P8R0S2T42N', ts: new Date(clock.now()).toISOString(), ...f }),
      ),
  }
}
const requests = (b: Fake) => b.sent.filter((f) => f.type === 'attest.request')
const answer = (b: Fake, ref: string, over: Record<string, unknown> = {}) =>
  b.say({ type: 'attest.response', ref, pubkey: PUBKEY, sig: SIG, chain: [CERT], ...over })

async function start(env: Record<string, string> = {}) {
  const clock = fakeClock()
  relay = await startTestRelay({ clock, env: { TRUST_PROXY_HOPS: '1', ...env } })
  return { clock, r: relay }
}
const post = (r: TestRelay, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${r.httpBase}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const settle = () => new Promise((res) => setTimeout(res, 30))

describe('POST /api/bridge/attest', () => {
  it('a round trip: 200 with {pubkey, sig, chain}, the request went to the live Mac only, no store, no cache', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    const pending = post(r, { nonce: NONCE })
    await waitFor(() => requests(bridge).length === 1, 3000, 'attest.request')
    const req = requests(bridge)[0] as { id: string; nonce: string }
    expect(req.nonce).toBe(NONCE)
    expect(req.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    answer(bridge, req.id)
    const res = await pending
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ pubkey: PUBKEY, sig: SIG, chain: [CERT] })
    // never in the outbox or the event log
    expect(r.runtime.store.outboxAll().some((row) => row.type === 'attest.request')).toBe(false)
  })

  it('no Origin header is fine: a native call sends none (no csrf)', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    const pending = post(r, { nonce: NONCE }, { 'x-real-ip': '203.0.113.2' })
    await waitFor(() => requests(bridge).length === 1, 3000, 'request')
    answer(bridge, (requests(bridge)[0] as { id: string }).id)
    expect((await pending).status).toBe(200)
  })

  it('400 bad_request for a nonce that is not 43 base64url characters, an extra field, or no JSON', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    for (const [i, body] of [
      { nonce: 'A'.repeat(42) },
      { nonce: `${'A'.repeat(42)}+` },
      { nonce: NONCE, x: 1 },
      {},
      '{',
      '[]',
    ].entries()) {
      const res = await post(r, body as never, { 'x-real-ip': `203.0.113.${10 + i}` })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad_request' })
    }
    expect(requests(bridge)).toHaveLength(0)
  })

  it('503 mac_offline with no live Mac', async () => {
    const { r } = await start()
    const res = await post(r, { nonce: NONCE })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'mac_offline' })
  })

  it("503 attest_unsupported when the live Mac's hello lacks attest/1, and nothing is sent to it", async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, ['themes/2'])
    const res = await post(r, { nonce: NONCE })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'attest_unsupported' })
    expect(requests(bridge)).toHaveLength(0)
  })

  it('504 attest_timeout after 5 s, and a late answer is dropped with nothing left waiting', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    const pending = post(r, { nonce: NONCE })
    await waitFor(() => requests(bridge).length === 1, 3000, 'request')
    const id = (requests(bridge)[0] as { id: string }).id
    clock.advance(4_999)
    await settle()
    clock.advance(1)
    const res = await pending
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'attest_timeout' })
    expect(waiting(r)).toBe(0)
    answer(bridge, id) // late: dropped silently
    await settle()
    expect(waiting(r)).toBe(0)
    expect(bridge.closed).toEqual([])
  })

  it('an unmatched answer, or one that is not a good frame, is dropped and resolves nobody', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    const pending = post(r, { nonce: NONCE })
    await waitFor(() => requests(bridge).length === 1, 3000, 'request')
    const id = (requests(bridge)[0] as { id: string }).id
    answer(bridge, '01JBF3V7Q8K2M4N6P8R0S2T49Z') // some other ref
    answer(bridge, id, { sig: 'short' }) // fails the frame schema
    await settle()
    expect(waiting(r)).toBe(1)
    answer(bridge, id)
    expect((await pending).status).toBe(200)
    expect(waiting(r)).toBe(0)
  })

  it('an answer resolves only its own call (two in flight)', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    const a = post(r, { nonce: NONCE }, { 'x-real-ip': '203.0.113.31' })
    const b = post(r, { nonce: 'D'.repeat(43) }, { 'x-real-ip': '203.0.113.32' })
    await waitFor(() => requests(bridge).length === 2, 3000, 'two requests')
    const [ra, rb] = requests(bridge) as Array<{ id: string; nonce: string }>
    answer(bridge, (rb as { id: string }).id, { sig: 'D'.repeat(86) })
    answer(bridge, (ra as { id: string }).id)
    expect(await (await b).json()).toMatchObject({ sig: 'D'.repeat(86) })
    expect(await (await a).json()).toMatchObject({ sig: SIG })
  })
})

/** How many calls the relay is holding open for the Mac. */
const waiting = (r: TestRelay): number => r.runtime.attest.waiting

describe('rate limits', () => {
  async function ok(r: TestRelay, bridge: Fake, ip: string, headers: Record<string, string> = {}) {
    const pending = post(r, { nonce: NONCE }, { 'x-real-ip': ip, ...headers })
    const before = requests(bridge).length
    const res = await Promise.race([pending, settle().then(() => null)])
    if (res) return res
    await waitFor(() => requests(bridge).length > before, 3000, 'request')
    answer(bridge, (requests(bridge).at(-1) as { id: string }).id)
    return pending
  }

  it('per address: a burst of 3, then 429 {error:"rate_limited"} with a Retry-After, and 1 more every 2 s; another address is untouched', async () => {
    const { clock, r } = await start()
    // a refused body spends this address's token and nothing relay-wide, so the address bucket shows on its own
    const bad = (ip: string) => post(r, { nonce: 'x' }, { 'x-real-ip': ip })
    for (let i = 0; i < 3; i++) expect((await bad('203.0.113.50')).status).toBe(400)
    const limited = await bad('203.0.113.50')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(limited.headers.get('cache-control')).toBe('no-store')
    expect((await bad('203.0.113.51')).status).toBe(400)
    clock.advance(1_999)
    expect((await bad('203.0.113.50')).status).toBe(429)
    clock.advance(1)
    expect((await bad('203.0.113.50')).status).toBe(400)
    expect((await bad('203.0.113.50')).status).toBe(429)
  })

  it('relay-wide public bucket: burst 2, then 0.5 a second, whatever the address', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    expect((await ok(r, bridge, '203.0.113.61')).status).toBe(200)
    expect((await ok(r, bridge, '203.0.113.62')).status).toBe(200)
    const limited = await ok(r, bridge, '203.0.113.63')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    clock.advance(2_000)
    expect((await ok(r, bridge, '203.0.113.64')).status).toBe(200)
  })

  it('a paired session uses its own bucket (burst 3) with the public one spent, and sets no cookie', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    expect((await ok(r, bridge, '203.0.113.71')).status).toBe(200)
    expect((await ok(r, bridge, '203.0.113.72')).status).toBe(200)
    expect((await ok(r, bridge, '203.0.113.73')).status).toBe(429) // public bucket is empty
    const paired = testAppHeaders(ORIGIN, 'dev_phone') // the test auth's session header
    for (let i = 0; i < 3; i++) {
      const res = await ok(r, bridge, `203.0.113.${80 + i}`, paired)
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect((await ok(r, bridge, '203.0.113.90', paired)).status).toBe(429)
  })

  it('a missing or bad session falls back to the public bucket', async () => {
    const { clock, r } = await start()
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    for (const ip of ['203.0.113.91', '203.0.113.92']) expect((await ok(r, bridge, ip)).status).toBe(200)
    expect((await ok(r, bridge, '203.0.113.93', { cookie: '__Host-talos_s=nope' })).status).toBe(429)
  })

  it('a refused request takes nothing from the relay-wide bucket: a 400 and an offline 503 are free of it', async () => {
    const { clock, r } = await start()
    for (let i = 0; i < 5; i++)
      expect((await post(r, { nonce: 'x' }, { 'x-real-ip': `203.0.113.${100 + i}` })).status).toBe(400)
    const bridge = await bridgeUp(r, clock, [ATTEST_FEATURE])
    expect((await ok(r, bridge, '203.0.113.120')).status).toBe(200)
    expect((await ok(r, bridge, '203.0.113.121')).status).toBe(200)
  })
})
