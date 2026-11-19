// BYOR phase 4 (docs/specs/BYOR-phase4-frame.md §3, §6): the Mac answers a phone's nonce with a signature the phone's own check
// (packages/protocol checkAttest) passes, at most one a second, never twice for one request, never off the current key; and
// `rotate` leaves a certificate the old key signed, so a phone pinned to the old key can move.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  ATTEST_FEATURE,
  type AttestVerdict,
  b64urlDecode,
  checkAttest,
  fpOfRaw,
  generateBridgeKey,
  newUlid,
  parseFrame,
  signRotationCert,
} from '@talos-app/protocol'
import { AttestResponder, appendRotation, chainFrom, readRotations } from '../src/attest.ts'
import { Bridge } from '../src/bridge.ts'
import { runCli } from '../src/cli.ts'
import { realClock } from '../src/clock.ts'
import { paths } from '../src/config.ts'
import { diskSync } from '../src/fsutil.ts'
import { bridgeFeatures } from '../src/handshake.ts'
import type { KeyMaterial } from '../src/keys.ts'
import { createLogger } from '../src/log.ts'
import { RelayClient } from '../src/relay-client.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

const ORIGIN = 'https://relay.example.com:8443'
const RELAY_ID = 'r_abcdefghijklmnopqrst'
const NONCE = `${'N'.repeat(42)}A`
const mkKey = async (): Promise<KeyMaterial> => {
  const k = await generateBridgeKey()
  return { privateKey: k.privateKey, publicKeyB64: k.publicKeyB64, keyId: k.keyId }
}
const fp = (k: KeyMaterial) => fpOfRaw(b64urlDecode(k.publicKeyB64))

function responder(
  key: KeyMaterial | undefined,
  over: { now?: () => number; rotations?: string; relayUrl?: string } = {},
) {
  const now = over.now ?? (() => 1_000_000)
  return new AttestResponder({
    key: () => key,
    relayUrl: () => over.relayUrl ?? 'https://relay.example.com:8443/',
    rotationsPath: over.rotations ?? `${tempHome()}/bridge.rotations.json`,
    now,
  })
}

const check = async (
  out: { pubkey: string; sig: string; chain: unknown[] },
  pinned: string,
  context: 'pair' | 'reconnect' = 'reconnect',
  nonce = NONCE,
): Promise<AttestVerdict> =>
  checkAttest({
    body: new TextEncoder().encode(JSON.stringify({ pubkey: out.pubkey, sig: out.sig, chain: out.chain })),
    nonce,
    origin: ORIGIN,
    relayId: RELAY_ID,
    pinnedFp: pinned,
    context,
  })

describe('the Mac answers an attest.request', () => {
  test('a good request gets a response the phone accepts, ref is the request id, origin is the configured URL origin', async () => {
    const key = await mkKey()
    const id = newUlid()
    const out = await responder(key).answer({ id, nonce: NONCE })
    expect(out).not.toBeNull()
    expect(out?.type).toBe('attest.response')
    expect(out?.ref).toBe(id)
    expect(out?.pubkey).toBe(key.publicKeyB64)
    expect(parseFrame(out, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(await check(out as never, fp(key), 'pair')).toEqual({ verdict: 'pass' })
  })
  test('a nonce that is not 43 base64url characters gets no answer', async () => {
    const r = responder(await mkKey())
    for (const nonce of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`])
      expect(await r.answer({ id: newUlid(), nonce })).toBeNull()
  })
  test('the same request id twice gets one answer', async () => {
    let t = 1_000_000
    const r = responder(await mkKey(), { now: () => t })
    const id = newUlid()
    expect(await r.answer({ id, nonce: NONCE })).not.toBeNull()
    t += 5_000
    expect(await r.answer({ id, nonce: NONCE })).toBeNull()
  })
  test('a flood inside one second gets 5 answers, and a second later one more', async () => {
    let t = 1_000_000
    const r = responder(await mkKey(), { now: () => t })
    let n = 0
    for (let i = 0; i < 20; i++) if (await r.answer({ id: newUlid(), nonce: NONCE })) n++
    expect(n).toBe(5)
    t += 1_000
    expect(await r.answer({ id: newUlid(), nonce: NONCE })).not.toBeNull()
  })
  test('an answer dropped by the limit is not remembered as answered: it was never signed', async () => {
    let t = 1_000_000
    const r = responder(await mkKey(), { now: () => t })
    for (let i = 0; i < 5; i++) await r.answer({ id: newUlid(), nonce: NONCE })
    const late = newUlid()
    expect(await r.answer({ id: late, nonce: NONCE })).toBeNull()
    t += 1_500
    expect(await r.answer({ id: late, nonce: NONCE })).not.toBeNull()
  })
  test('no key, or no relay URL: no answer', async () => {
    expect(await responder(undefined).answer({ id: newUlid(), nonce: NONCE })).toBeNull()
    const noUrl = new AttestResponder({
      key: () => undefined,
      relayUrl: () => undefined,
      rotationsPath: `${tempHome()}/r.json`,
      now: () => 1,
    })
    expect(await noUrl.answer({ id: newUlid(), nonce: NONCE })).toBeNull()
  })
  test('it signs with the key the bridge holds NOW, read at each request', async () => {
    const a = await mkKey()
    const b = await mkKey()
    let cur = a
    let t = 0
    const r = new AttestResponder({
      key: () => cur,
      relayUrl: () => ORIGIN,
      rotationsPath: `${tempHome()}/r.json`,
      now: () => t,
    })
    expect((await r.answer({ id: newUlid(), nonce: NONCE }))?.pubkey).toBe(a.publicKeyB64)
    cur = b
    t += 2_000
    expect((await r.answer({ id: newUlid(), nonce: NONCE }))?.pubkey).toBe(b.publicKeyB64)
  })
  test('the request id memory is bounded (the last 64) and an old id may come back', async () => {
    let t = 0
    const r = responder(await mkKey(), { now: () => t })
    const first = newUlid()
    await r.answer({ id: first, nonce: NONCE })
    for (let i = 0; i < 64; i++) {
      t += 1_100
      await r.answer({ id: newUlid(), nonce: NONCE })
    }
    t += 1_100
    expect(await r.answer({ id: first, nonce: NONCE })).not.toBeNull()
  })
})

describe("the Mac's limit with the relay in front of it", () => {
  // The relay's PUBLIC bucket (0.5/s, burst 2) and PAIRED bucket (0.5/s, burst 3) both feed this one. A stranger at the public
  // rate takes 1 every 2 s; the owner's phone may then send its paired burst of 3 at once. All 3 must be signed.
  test("a stranger at the public rate plus the owner's paired burst of 3: every owner request is answered", async () => {
    let t = 1_000_000
    const r = responder(await mkKey(), { now: () => t })
    for (let i = 0; i < 20; i++) {
      expect(await r.answer({ id: newUlid(), nonce: NONCE })).not.toBeNull() // the stranger, every 2 s, for a while
      t += 2_000
    }
    const owner = []
    for (let i = 0; i < 3; i++) owner.push(await r.answer({ id: newUlid(), nonce: NONCE })) // same instant, stranger's one before
    expect(owner.every((o) => o !== null)).toBe(true)
  })
  test('it is still a limit: a burst of 5 passes, the 6th inside the same second does not, and refill is 1 a second', async () => {
    let t = 1_000_000
    const r = responder(await mkKey(), { now: () => t })
    for (let i = 0; i < 5; i++) expect(await r.answer({ id: newUlid(), nonce: NONCE })).not.toBeNull()
    expect(await r.answer({ id: newUlid(), nonce: NONCE })).toBeNull()
    t += 1_000
    expect(await r.answer({ id: newUlid(), nonce: NONCE })).not.toBeNull()
    expect(await r.answer({ id: newUlid(), nonce: NONCE })).toBeNull()
  })
})

describe('the chain in the answer', () => {
  async function cert(oldK: KeyMaterial, newK: KeyMaterial) {
    return {
      relay_id: RELAY_ID,
      old_pubkey: oldK.publicKeyB64,
      new_pubkey: newK.publicKeyB64,
      sig: await signRotationCert(oldK.privateKey, RELAY_ID, fp(oldK), fp(newK)),
    }
  }
  test('after a rotation the chain makes the phone repin from the old fp', async () => {
    const k0 = await mkKey()
    const k1 = await mkKey()
    const file = `${tempHome()}/bridge.rotations.json`
    appendRotation(file, await cert(k0, k1))
    const out = await responder(k1, { rotations: file }).answer({ id: newUlid(), nonce: NONCE })
    expect(out?.chain).toHaveLength(1)
    expect(await check(out as never, fp(k0))).toEqual({ verdict: 'repin', new_fp: fp(k1) })
    expect(await check(out as never, fp(k0), 'pair')).toEqual({ verdict: 'fail', reason: 'repin_at_pair' })
    expect(await check(out as never, fp(k1))).toEqual({ verdict: 'pass' })
  })
  test('walks back from the current key, oldest first; certs of failed tries drop out', async () => {
    const [k0, k1, k2, dead] = [await mkKey(), await mkKey(), await mkKey(), await mkKey()]
    const c01 = await cert(k0, k1)
    const failed = await cert(k1, dead) // a try the relay never took
    const c12 = await cert(k1, k2)
    const certs = [c01, failed, c12]
    expect(chainFrom(certs, k2.publicKeyB64)).toEqual([c01, c12])
    expect(chainFrom(certs, k1.publicKeyB64)).toEqual([c01])
    expect(chainFrom(certs, k0.publicKeyB64)).toEqual([])
    expect(chainFrom([], k0.publicKeyB64)).toEqual([])
  })
  test('at most 8, the newest 8, and a loop in the file ends', async () => {
    const keys = await Promise.all(Array.from({ length: 12 }, mkKey))
    const certs = []
    for (let i = 0; i < 11; i++) certs.push(await cert(keys[i] as KeyMaterial, keys[i + 1] as KeyMaterial))
    const chain = chainFrom(certs, (keys[11] as KeyMaterial).publicKeyB64)
    expect(chain).toHaveLength(8)
    expect(chain[0]).toEqual(certs[3] as never)
    expect(chain[7]).toEqual(certs[10] as never)
    const a = keys[0] as KeyMaterial
    const b = keys[1] as KeyMaterial
    expect(chainFrom([await cert(a, b), await cert(b, a)], a.publicKeyB64).length).toBeLessThanOrEqual(8)
  })
  test('an unreadable or wrong-shaped file reads as no certificates', () => {
    const f = `${tempHome()}/x.json`
    expect(readRotations(f)).toEqual([])
    writeFileSync(f, '{')
    expect(readRotations(f)).toEqual([])
    writeFileSync(f, JSON.stringify([{ relay_id: 1 }, 'x']))
    expect(readRotations(f)).toEqual([])
  })
  test('appendRotation writes a 0600 JSON array and does not repeat a new_pubkey', async () => {
    const [a, b] = [await mkKey(), await mkKey()]
    const f = `${tempHome()}/bridge.rotations.json`
    const c = await cert(a, b)
    expect(appendRotation(f, c)).toBe(true)
    expect(appendRotation(f, c)).toBe(false)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([c])
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
})

describe('hello', () => {
  test('attest/1 is the last feature, with nothing optional on and with everything on', () => {
    expect(ATTEST_FEATURE).toBe('attest/1')
    expect(bridgeFeatures({}).at(-1)).toBe(ATTEST_FEATURE)
    const on = { available: true }
    const all = bridgeFeatures({
      search: on,
      memory: on,
      health: on,
      speak: on,
      folders: on,
      files: on,
      agentsMd: on,
      filesPut: on,
      filesSent: on,
      memoryRoots: on,
      problems: {},
      config: { subthreadsSupported: () => true },
    })
    expect(all.at(-1)).toBe(ATTEST_FEATURE)
    expect(all.filter((f) => f === ATTEST_FEATURE)).toHaveLength(1)
  })
})

// ---- the answer goes out on the socket the request came in on ----------------------------------------------------------

class FakeSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static made: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.made.push(this)
  }
  send(text: string) {
    this.sent.push(JSON.parse(text))
  }
  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    queueMicrotask(() => this.onclose?.({ code }))
  }
  deliver(type: string, fields: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type, id: newUlid(), ts: new Date().toISOString(), ...fields }) })
  }
}
const RealSocket = globalThis.WebSocket
const clients: RelayClient[] = []
afterEach(async () => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = RealSocket
  FakeSocket.made = []
  for (const c of clients.splice(0)) await c.stop()
})
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  if (!ok()) throw new Error(`timed out: ${what}`)
}

async function connected(onAttest: (f: { id: string; nonce: string }) => Promise<Record<string, unknown> | null>) {
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  const k = await mkKey()
  const client = new RelayClient({
    relayUrl: 'http://127.0.0.1:1',
    loadKeys: async () => [k],
    client: { name: 'test', version: '0' },
    features: () => [],
    agentConfigRev: () => 0,
    clock: realClock,
    log: createLogger(null, 'error', () => {}),
    random: () => 0,
    events: { onReady() {}, onFrame() {}, onBadFrame() {}, onDisconnect() {}, onSuperseded() {} },
  })
  client.onAttest = onAttest
  clients.push(client)
  client.start()
  await until(() => FakeSocket.made.length > 0, 'socket')
  const ws = FakeSocket.made[0] as FakeSocket
  ws.deliver('challenge', { nonce: 'n'.repeat(43), server_time: 1_700_000_000, relay_host: '127.0.0.1:1', protocol: 1 })
  await until(() => ws.sent.some((f) => f.type === 'hello'), 'hello')
  ws.deliver('ready', {
    session_id: 'sess_test',
    policy: { max_frame_bytes: 65536, ping_ms: 60_000 },
    server_seq: 0,
    presence: { bridge_online: true, last_seen: null, queue_depth: 0 },
    features: [],
  })
  await until(() => client.connected, 'ready')
  return { client, ws }
}

describe('on the wire', () => {
  test('the answer is a plain frame on the socket the request arrived on', async () => {
    const seen: string[] = []
    const { ws } = await connected(async (f) => {
      seen.push(f.nonce)
      return {
        v: 1,
        type: 'attest.response',
        id: newUlid(),
        ts: new Date().toISOString(),
        ref: f.id,
        pubkey: 'B'.repeat(43),
        sig: 'C'.repeat(86),
        chain: [],
      }
    })
    ws.deliver('attest.request', { id: 'REQ0000000000000000000000A'.slice(0, 26), nonce: NONCE })
    await until(() => ws.sent.some((f) => f.type === 'attest.response'), 'answer')
    expect(seen).toEqual([NONCE])
    expect((ws.sent.find((f) => f.type === 'attest.response') as { ref: string }).ref).toBe(
      'REQ0000000000000000000000A',
    )
  })
  test('a null answer sends nothing', async () => {
    const { ws } = await connected(async () => null)
    ws.deliver('attest.request', { nonce: NONCE })
    await new Promise((r) => setTimeout(r, 60))
    expect(ws.sent.some((f) => f.type === 'attest.response')).toBe(false)
  })
  test('a request that finished after the socket was replaced is not sent on the new one', async () => {
    let release: (v: Record<string, unknown>) => void = () => {}
    const { client, ws } = await connected(() => new Promise((r) => (release = r)))
    ws.deliver('attest.request', { nonce: NONCE })
    await new Promise((r) => setTimeout(r, 20))
    await client.restartNow()
    await until(() => FakeSocket.made.length > 1, 'second socket')
    const second = FakeSocket.made[1] as FakeSocket
    release({
      v: 1,
      type: 'attest.response',
      id: newUlid(),
      ts: new Date().toISOString(),
      ref: newUlid(),
      pubkey: 'B'.repeat(43),
      sig: 'C'.repeat(86),
      chain: [],
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(second.sent.some((f) => f.type === 'attest.response')).toBe(false)
    expect(ws.sent.some((f) => f.type === 'attest.response')).toBe(false)
  })
})

// ---- rotation certificates ---------------------------------------------------------------------------------------------

type Stub = { url: string; hits: string[]; stop(): void }
function relayStub(descriptor: 'found' | 'absent' | 'down', onRotate: () => void = () => {}): Stub {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      hits.push(`${req.method} ${path}`)
      if (path === '/.well-known/talos-relay') {
        if (descriptor === 'absent') return new Response('{}', { status: 404 })
        if (descriptor === 'down') return new Response('x', { status: 500 })
        return Response.json({
          protocol: 1,
          relay_version: '1.0.0',
          relay_id: RELAY_ID,
          kind: 'self',
          min_app: '0.0.0',
        })
      }
      if (path === '/bridge/rotate') {
        onRotate()
        return Response.json({ ok: true, key_id: 'k_stub' })
      }
      return new Response('no', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) }
}

const cliIO = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

describe('talos-app rotate', () => {
  let stub: Stub | undefined
  afterEach(() => stub?.stop())
  async function homeFor(url: string) {
    const home = `${tempHome()}/app`
    expect(await runCli(['init', '--relay-url', url], cliIO().io, { TALOS_APP_HOME: home })).toBe(0)
    return home
  }

  test('descriptor unavailable: rotate refuses, says so, and changes nothing', async () => {
    stub = relayStub('down')
    const home = await homeFor(stub.url)
    const p = paths(home)
    const before = readFileSync(p.bridgeKey, 'utf8')
    const c = cliIO()
    expect(await runCli(['rotate'], c.io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(1)
    expect(c.err.join('\n')).toMatch(/descriptor/i)
    expect(c.err.join('\n')).toContain('bridge.key is unchanged')
    expect(readFileSync(p.bridgeKey, 'utf8')).toBe(before)
    expect(existsSync(p.bridgeKeyNext)).toBe(false)
    expect(existsSync(p.bridgeRotations)).toBe(false)
    expect(stub.hits.some((h) => h.includes('/bridge/rotate'))).toBe(false)
  })

  test('descriptor absent (a real 404): rotates with no certificate', async () => {
    stub = relayStub('absent')
    const home = await homeFor(stub.url)
    const p = paths(home)
    const old = JSON.parse(readFileSync(p.bridgeKey, 'utf8')).public
    const c = cliIO()
    expect(await runCli(['rotate'], c.io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(0)
    expect(JSON.parse(readFileSync(p.bridgeKey, 'utf8')).public).not.toBe(old)
    expect(existsSync(p.bridgeRotations)).toBe(false)
    expect(c.out.join('\n')).toContain('Phones paired with this Mac will ask you to confirm the new key.')
  })

  test('descriptor found: the old key signs a certificate, 0600, written before the relay call, and the new answer carries it', async () => {
    let certAtRotate: unknown[] | undefined
    let rotationsFile = ''
    stub = relayStub('found', () => {
      certAtRotate = readRotations(rotationsFile)
    })
    const home = await homeFor(stub.url)
    const p = paths(home)
    rotationsFile = p.bridgeRotations
    const oldStored = JSON.parse(readFileSync(p.bridgeKey, 'utf8')) as { public: string }
    const c = cliIO()
    expect(await runCli(['rotate'], c.io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(0)
    const nowStored = JSON.parse(readFileSync(p.bridgeKey, 'utf8')) as { public: string }
    const certs = readRotations(p.bridgeRotations)
    expect(certs).toHaveLength(1)
    expect(certAtRotate).toEqual(certs) // already in the file when the relay was asked to switch
    expect(certs[0]).toMatchObject({ relay_id: RELAY_ID, old_pubkey: oldStored.public, new_pubkey: nowStored.public })
    expect(statSync(p.bridgeRotations).mode & 0o777).toBe(0o600)
    expect(c.out.join('\n')).toContain('Phones paired with this Mac will ask you to confirm the new key.')
    // the descriptor was asked before the rotate call
    expect(stub.hits.findIndex((h) => h.includes('talos-relay'))).toBeLessThan(
      stub.hits.findIndex((h) => h.includes('/bridge/rotate')),
    )
    // the phone's check, with the Mac's own answer after the switch
    const { loadKeyFile } = await import('../src/keys.ts')
    const key = (await loadKeyFile(p.bridgeKey)) as KeyMaterial
    const out = await new AttestResponder({
      key: () => key,
      relayUrl: () => ORIGIN,
      rotationsPath: p.bridgeRotations,
      now: () => 5,
    }).answer({ id: newUlid(), nonce: NONCE })
    expect(await check(out as never, fpOfRaw(b64urlDecode(oldStored.public)))).toEqual({
      verdict: 'repin',
      new_fp: fpOfRaw(b64urlDecode(nowStored.public)),
    })
  })

  test('a leftover bridge.key.next whose certificate is in the file is not given a second one', async () => {
    stub = relayStub('found')
    const home = await homeFor(stub.url)
    const p = paths(home)
    const { loadKeyFile, newStoredKey } = await import('../src/keys.ts')
    const old = (await loadKeyFile(p.bridgeKey)) as KeyMaterial
    const next = await newStoredKey()
    writeFileSync(p.bridgeKeyNext, JSON.stringify(next), { mode: 0o600 })
    const nextKey = (await loadKeyFile(p.bridgeKeyNext)) as KeyMaterial
    const c0 = {
      relay_id: RELAY_ID,
      old_pubkey: old.publicKeyB64,
      new_pubkey: next.public,
      sig: await signRotationCert(old.privateKey, RELAY_ID, fp(old), fp(nextKey)),
    }
    appendRotation(p.bridgeRotations, c0)
    expect(await runCli(['rotate'], cliIO().io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(0)
    expect(readRotations(p.bridgeRotations)).toEqual([c0])
    expect(JSON.parse(readFileSync(p.bridgeKey, 'utf8')).public).toBe(next.public)
  })

  test('a rotations file that does not parse (or has a bad entry): rotate refuses, names the file, changes nothing', async () => {
    for (const bad of ['{', JSON.stringify([{ relay_id: 'x' }]), '{"a":1}']) {
      stub = relayStub('found')
      const home = await homeFor(stub.url)
      const p = paths(home)
      writeFileSync(p.bridgeRotations, bad, { mode: 0o600 })
      const before = readFileSync(p.bridgeKey, 'utf8')
      const c = cliIO()
      expect(await runCli(['rotate'], c.io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(1)
      expect(c.err.join('\n')).toContain('bridge.rotations.json')
      expect(readFileSync(p.bridgeKey, 'utf8')).toBe(before)
      expect(readFileSync(p.bridgeRotations, 'utf8')).toBe(bad)
      expect(existsSync(p.bridgeKeyNext)).toBe(false)
      expect(stub.hits.some((h) => h.includes('/bridge/rotate'))).toBe(false)
      stub.stop()
    }
  })

  test('the rotations file is written durably (flushed to disk)', async () => {
    stub = relayStub('found')
    const home = await homeFor(stub.url)
    const real = diskSync.fsync
    let calls = 0
    diskSync.fsync = (fd) => {
      calls++
      real(fd)
    }
    try {
      expect(await runCli(['rotate'], cliIO().io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(0)
    } finally {
      diskSync.fsync = real
    }
    expect(calls).toBeGreaterThan(0)
  })

  test('a certificate that cannot be written removes the bridge.key.next just made, and no relay call is made', async () => {
    stub = relayStub('found')
    const home = await homeFor(stub.url)
    const p = paths(home)
    const before = readFileSync(p.bridgeKey, 'utf8')
    const real = diskSync.fsync
    diskSync.fsync = () => {
      throw new Error('disk full')
    }
    const c = cliIO()
    try {
      expect(await runCli(['rotate'], c.io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: stub.url })).toBe(1)
    } finally {
      diskSync.fsync = real
    }
    expect(c.err.join('\n')).toContain('could not write the rotation certificate')
    expect(existsSync(p.bridgeKeyNext)).toBe(false)
    expect(readFileSync(p.bridgeKey, 'utf8')).toBe(before)
    expect(stub.hits.some((h) => h.includes('/bridge/rotate'))).toBe(false)
  })

  test('the FORCE hint of the key-refused line says phones paired before going back to an older key pair again', async () => {
    const src = readFileSync(new URL('../src/cli-main.ts', import.meta.url), 'utf8')
    expect(src.match(/Phones paired before going back to an older key have to pair again\./g)?.length).toBe(2)
  })
})

describe('a real bridge behind the fake relay', () => {
  let h: Harness | undefined
  afterEach(async () => h?.stop())
  test("answers with the key in bridge.key and the origin of its relay URL; the phone's check passes; hello lists attest/1 last", async () => {
    h = await startHarness()
    const hello = h.relay.frames.find((r) => r.direction === 'from_bridge' && r.frame.type === 'hello')?.frame as {
      client: { features: string[] }
    }
    expect(hello.client.features.at(-1)).toBe(ATTEST_FEATURE)
    const sent = h.relay.sendToBridge({ type: 'attest.request', nonce: NONCE }, { durable: false })
    await waitFor(
      () => h?.relay.frames.some((r) => r.direction === 'from_bridge' && r.frame.type === 'attest.response') ?? false,
      4000,
      'attest.response',
    )
    const res = h.relay.frames.find((r) => r.direction === 'from_bridge' && r.frame.type === 'attest.response')
      ?.frame as unknown as { ref: string; pubkey: string; sig: string; chain: unknown[] }
    expect(res.ref).toBe(String(sent.id))
    const stored = JSON.parse(readFileSync(paths(h.home).bridgeKey, 'utf8')) as { public: string }
    expect(res.pubkey).toBe(stored.public)
    const origin = new URL(h.relay.httpUrl).origin
    const verdict = await checkAttest({
      body: new TextEncoder().encode(JSON.stringify({ pubkey: res.pubkey, sig: res.sig, chain: res.chain })),
      nonce: NONCE,
      origin,
      relayId: RELAY_ID,
      pinnedFp: fpOfRaw(b64urlDecode(stored.public)),
      context: 'pair',
    })
    expect(verdict).toEqual({ verdict: 'pass' })
  })
})

describe('a socket dialled with a fallback key', () => {
  let h: Harness | undefined
  afterEach(async () => h?.stop())
  test('still signs with bridge.key, the current key, never the .prev the socket connected with', async () => {
    h = await startHarness({ startBridge: false })
    const p = paths(h.home)
    const { newStoredKey } = await import('../src/keys.ts')
    const relayKey = readFileSync(p.bridgeKey, 'utf8')
    const relayPub = (JSON.parse(relayKey) as { public: string }).public
    writeFileSync(p.bridgeKeyPrev, relayKey, { mode: 0o600 }) // the key the relay knows: the socket dials with this
    const current = await newStoredKey()
    writeFileSync(p.bridgeKey, JSON.stringify(current), { mode: 0o600 }) // unknown to the relay: refused (4401), then .prev
    const b = await Bridge.create({
      env: h.bridge.ctx.env,
      logger: createLogger(null, 'error', () => {}),
      random: () => 0,
      inbound: { settleMs: 10 },
    })
    b.setEmit(async () => {})
    b.start()
    try {
      await waitFor(() => h?.relay.bridgeConnected ?? false, 5000, 'connect with the previous key')
      h.relay.sendToBridge({ type: 'attest.request', nonce: NONCE }, { durable: false })
      await waitFor(
        () => h?.relay.frames.some((r) => r.frame.type === 'attest.response') ?? false,
        4000,
        'attest.response',
      )
      const res = h.relay.frames.find((r) => r.frame.type === 'attest.response')?.frame as unknown as {
        pubkey: string
        sig: string
        chain: unknown[]
      }
      expect(res.pubkey).toBe(current.public)
      expect(res.pubkey).not.toBe(relayPub)
      const verdict = await checkAttest({
        body: new TextEncoder().encode(JSON.stringify({ pubkey: res.pubkey, sig: res.sig, chain: res.chain })),
        nonce: NONCE,
        origin: new URL(h.relay.httpUrl).origin,
        relayId: RELAY_ID,
        pinnedFp: fpOfRaw(b64urlDecode(current.public)),
        context: 'pair',
      })
      expect(verdict).toEqual({ verdict: 'pass' })
    } finally {
      await b.stop()
    }
  })
})
