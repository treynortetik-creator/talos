// Review follow-ups for the relay-caps package. Each block drives the REAL routes (real auth, real core, real hooks)
// through Hono's request(), the same way relay-caps.test.ts does.
//   1. a stranger holding upload slots must not lock the real Mac out (hash-first proof, separate pools)
//   2. a GET reads nothing, so it never waits on the upload gate
//   3. POST /share-target is not shrunk by the 64 KiB blanket cap
//   4. the hook receiver: bounded in flight, with a read deadline
//   5. the client address: IPv6 per /64, mapped IPv4, a duplicated X-Real-IP, and a limiter that cannot be flooded
import { createHash } from 'node:crypto'
import { generateBridgeKey, signBridgeHttp } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { RateLimiter } from '../../src/auth/limits.ts'
import { canonicalAddress, pickClientIp } from '../../src/client-ip.ts'
import {
  HOOK_READS_MAX,
  HOOK_READS_PER_IP,
  UNVERIFIED_FRAMES_PER_IP,
  UNVERIFIED_READS_PER_IP,
} from '../../src/core/upload-gate.ts'
import { buildApp } from '../../src/routes.ts'
import { setup } from '../hooks/harness.ts'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  resetAuthImplementation()
})

const send = (app: { request: (r: Request) => Response | Promise<Response> }, url: string, init: RequestInit) =>
  app.request(new Request(`http://relay.test${url}`, { ...init, duplex: 'half' } as RequestInit))

/** One chunk, then nothing until `release()`. */
function stalled() {
  let release: () => void = () => {}
  const gate = new Promise<void>((res) => {
    release = res
  })
  let first = true
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (first) {
        first = false
        c.enqueue(new Uint8Array(1024))
        return
      }
      await gate
      c.close()
    },
  })
  return { stream, release }
}
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const MEDIA = '/bridge/media/md_0000000000000000000000000A'
const PNG = (n: number) => {
  const b = new Uint8Array(n)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return b
}

describe('1. a stranger holding upload slots cannot lock the real Mac out', () => {
  it('junk signatures that name the real key id and carry a hash are refused at once, take no slot, and the Mac still uploads', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const real = r.bridgeKey
    // The attacker names the real key id with a fresh time and a junk signature. Twenty of them, from five addresses,
    // each trying to stall after one chunk. None may be held.
    const junk = `TalosBridge key_id=${real.keyId},ts=${Math.floor(Date.now() / 1000)},nonce=AAAAAAAAAAAAAAAAAAAAAA,sig=${'A'.repeat(86)}`
    const attackers = Array.from({ length: 20 }, (_, i) => {
      const s = stalled()
      const res = Promise.resolve(
        send(app, `/bridge/media/md_${String(i).padStart(26, '0')}`, {
          method: 'PUT',
          headers: { authorization: junk, 'X-Real-IP': `198.51.100.${i % 5}`, 'x-talos-sha256': '0'.repeat(64) },
          body: s.stream,
        }),
      )
      return { s, res }
    })
    // Every one answers 401 without waiting for the body to finish.
    for (const a of attackers) expect((await a.res).status).toBe(401)
    // The Mac, from the same address as one attacker, uploads a 128 KiB file with its hash header: lands.
    const bytes = PNG(128 * 1024)
    const authorization = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: bytes,
    })
    const ok = await send(app, MEDIA, {
      method: 'PUT',
      headers: {
        authorization,
        'content-type': 'image/png',
        'x-talos-sha256': sha(bytes),
        'X-Real-IP': '198.51.100.0',
      },
      body: bytes,
    })
    expect(ok.status).toBe(200)
    for (const a of attackers) a.s.release()
  })

  it('the Mac still lands a large upload while the unproven pool is full of hash-less stalled reads', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const real = r.bridgeKey
    const hashless = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: '',
    })
    const held = Array.from({ length: UNVERIFIED_READS_PER_IP }, () => {
      const s = stalled()
      return {
        s,
        res: Promise.resolve(
          send(app, MEDIA, {
            method: 'PUT',
            headers: { authorization: hashless, 'X-Real-IP': '198.51.100.9' },
            body: s.stream,
          }),
        ),
      }
    })
    await pause(100)
    const bytes = PNG(100 * 1024)
    const authorization = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: bytes,
    })
    const ok = await send(app, MEDIA, {
      method: 'PUT',
      headers: {
        authorization,
        'content-type': 'image/png',
        'x-talos-sha256': sha(bytes),
        'X-Real-IP': '198.51.100.9',
      },
      body: bytes,
    })
    expect(ok.status).toBe(200) // same address, pool full: a proven upload does not wait on it
    for (const h of held) h.s.release()
    for (const h of held) expect((await h.res).status).toBe(401)
  })

  it('a hash the body does not match is refused, and the header cannot be replayed', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const real = r.bridgeKey
    const signedFor = PNG(80 * 1024)
    const authorization = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: signedFor,
    })
    const other = PNG(80 * 1024)
    other[100] = 7 // a different body under the same signed hash
    const headers = {
      authorization,
      'content-type': 'image/png',
      'x-talos-sha256': sha(signedFor),
      'X-Real-IP': '198.51.100.10',
    }
    expect((await send(app, MEDIA, { method: 'PUT', headers, body: other })).status).toBe(401)
    // the nonce is spent on the proof; the genuine body under the same header is a replay
    expect((await send(app, MEDIA, { method: 'PUT', headers, body: signedFor })).status).toBe(401)
    // a stranger's key with a hash header is refused too (identity is the signature, not the claim)
    const stranger = await generateBridgeKey()
    const sa = await signBridgeHttp({
      privateKey: stranger.privateKey,
      keyId: stranger.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: signedFor,
    })
    expect(
      (await send(app, MEDIA, { method: 'PUT', headers: { ...headers, authorization: sa }, body: signedFor })).status,
    ).toBe(401)
  })

  it('an older peer with no hash header still uploads (read first, checked after)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const bytes = PNG(100 * 1024)
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: bytes,
    })
    const ok = await send(app, MEDIA, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'image/png', 'X-Real-IP': '198.51.100.11' },
      body: bytes,
    })
    expect(ok.status).toBe(200)
    // an unknown/garbled hash header degrades to the same path instead of failing the request
    const bytes2 = PNG(90 * 1024)
    const a2 = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'PUT',
      pathWithQuery: '/bridge/media/md_0000000000000000000000000B',
      body: bytes2,
    })
    const odd = await send(app, '/bridge/media/md_0000000000000000000000000B', {
      method: 'PUT',
      headers: {
        authorization: a2,
        'content-type': 'image/png',
        'x-talos-sha256': 'not-a-hash',
        'X-Real-IP': '198.51.100.11',
      },
      body: bytes2,
    })
    expect(odd.status).toBe(400) // reaches the route, which refuses the mismatched claim as before
  })

  it('stalled hash-less frame posts have their own pool: media uploads are unaffected, and the frame pool is bounded', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const real = r.bridgeKey
    const auth = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body: '',
    })
    const held = Array.from({ length: UNVERIFIED_FRAMES_PER_IP }, () => {
      const s = stalled()
      return {
        s,
        res: Promise.resolve(
          send(app, '/bridge/post', {
            method: 'POST',
            headers: { authorization: auth, 'X-Real-IP': '198.51.100.12' },
            body: s.stream,
          }),
        ),
      }
    })
    await pause(100)
    const over = await send(app, '/bridge/post', {
      method: 'POST',
      headers: { authorization: auth, 'X-Real-IP': '198.51.100.12' },
      body: stalled().stream,
    })
    expect(over.status).toBe(429)
    const bytes = PNG(100 * 1024)
    const a = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'PUT',
      pathWithQuery: MEDIA,
      body: bytes,
    })
    const media = await send(app, MEDIA, {
      method: 'PUT',
      headers: {
        authorization: a,
        'content-type': 'image/png',
        'x-talos-sha256': sha(bytes),
        'X-Real-IP': '198.51.100.12',
      },
      body: bytes,
    })
    expect(media.status).toBe(200)
    for (const h of held) h.s.release()
    for (const h of held) expect((await h.res).status).toBe(401)
  })
})

describe('2. GET /bridge/media/:id reads nothing and never waits on the upload gate', () => {
  it('with the address full of stalled uploads and frame posts, a signed GET still gets its answer (404 for an unknown id, not 429)', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const real = r.bridgeKey
    const ip = '198.51.100.13'
    const stall = async (n: number, method: string, path: string) => {
      const authorization = await signBridgeHttp({
        privateKey: real.privateKey,
        keyId: real.keyId,
        method,
        pathWithQuery: path,
        body: '',
      })
      return Array.from({ length: n }, () => {
        const s = stalled()
        return {
          s,
          res: Promise.resolve(
            send(app, path, { method, headers: { authorization, 'X-Real-IP': ip }, body: s.stream }),
          ),
        }
      })
    }
    // both pools, for this address, are full: nothing hash-less and large can get in from here
    const held = [
      ...(await stall(UNVERIFIED_READS_PER_IP, 'PUT', MEDIA)),
      ...(await stall(UNVERIFIED_FRAMES_PER_IP, 'POST', '/bridge/post')),
    ]
    await pause(150)
    const probe = await stall(1, 'PUT', MEDIA)
    expect((await probe[0]?.res)?.status).toBe(429) // the control: the pool really is full
    const get = await signBridgeHttp({
      privateKey: real.privateKey,
      keyId: real.keyId,
      method: 'GET',
      pathWithQuery: MEDIA,
    })
    const res = await send(app, MEDIA, { method: 'GET', headers: { authorization: get, 'X-Real-IP': ip } })
    expect(res.status).toBe(404)
    for (const h of held) h.s.release()
    for (const h of held) await h.res
  })
})

describe('3. POST /share-target is not shrunk by the 64 KiB cap', () => {
  it('a 300 KiB multipart share (declared length) and a chunked one both land on the 303 retry page', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const boundary = '----b'
    const part = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
    const body = new Uint8Array([
      ...new TextEncoder().encode(part),
      ...new Uint8Array(300 * 1024),
      ...new TextEncoder().encode(`\r\n--${boundary}--\r\n`),
    ])
    const declared = await send(app, '/share-target', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
      body,
    })
    expect(declared.status).toBe(303)
    expect(declared.headers.get('location')).toBe('/share?retry=1')
    const chunked = await send(app, '/share-target', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: new ReadableStream({
        start(c) {
          c.enqueue(body)
          c.close()
        },
      }),
    })
    expect(chunked.status).toBe(303)
  })
})

describe('4. the hook receiver is bounded before the signature is checked', () => {
  it('only a few bodies can be mid-read, in all and per address; a stalled one is cut with 408; the slot comes back', async () => {
    const s = setup({ bodyIdleMs: 800, bodyTotalMs: 5000 })
    const c = await s.create('generic')
    const url = `${s.f.services.env.PUBLIC_ORIGIN}/hook/generic/${c.id}`
    const open = (ip: string) => {
      const st = stalled()
      return Promise.resolve(
        s.app.request(
          new Request(url, {
            method: 'POST',
            headers: { 'X-Real-IP': ip, 'content-type': 'application/json' },
            body: st.stream,
            duplex: 'half',
          } as RequestInit),
        ),
      )
    }
    const held: Array<Promise<Response>> = []
    for (let i = 0; i < HOOK_READS_PER_IP; i++) held.push(open('198.51.100.60'))
    await pause(150)
    const perIp = await open('198.51.100.60')
    expect(perIp.status).toBe(429) // refused without reading
    // fill the total from other addresses, then one more address is refused
    const perAddr = Math.ceil(HOOK_READS_MAX / HOOK_READS_PER_IP)
    let opened = HOOK_READS_PER_IP
    for (let a = 0; opened < HOOK_READS_MAX; a++) {
      for (let i = 0; i < HOOK_READS_PER_IP && opened < HOOK_READS_MAX; i++, opened++)
        held.push(open(`198.51.100.${70 + a}`))
    }
    expect(perAddr).toBeGreaterThan(1)
    await pause(150)
    expect((await open('198.51.100.99')).status).toBe(429)
    // the stalled bodies are cut by the deadline
    for (const h of held) expect((await h).status).toBe(408)
    // and the pool is free again: a signed delivery now lands
    const ok = await s.send(
      'generic',
      c.id as string,
      c.secret as string,
      { title: 'after', summary: 'x' },
      { headers: { 'X-Real-IP': '198.51.100.60' } },
    )
    expect(ok.status).toBe(200)
  })

  it('a sender that trickles a byte at a time is cut by the total deadline', async () => {
    const s = setup({ bodyIdleMs: 400, bodyTotalMs: 700 })
    const c = await s.create('generic')
    let n = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        await pause(150)
        ctl.enqueue(new Uint8Array([32]))
        if (++n > 100) ctl.close()
      },
    })
    const res = await s.app.request(
      new Request(`${s.f.services.env.PUBLIC_ORIGIN}/hook/generic/${c.id}`, {
        method: 'POST',
        headers: { 'X-Real-IP': '198.51.100.61' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    )
    expect(res.status).toBe(408)
    expect(res.headers.get('connection')).toBe('close')
  })

  it('a normal delivery and an over-cap body behave as before', async () => {
    const s = setup()
    const c = await s.create('generic')
    const ok = await s.send('generic', c.id as string, c.secret as string, { title: 't', summary: 's' })
    expect(ok.status).toBe(200)
    const big = await s.post('generic', c.id as string, new Uint8Array(1_100_000))
    expect(big.status).toBe(413)
  })
})

describe('5. the client address', () => {
  it('IPv6 counts per /64, mapped IPv4 is the IPv4 address, anything else is left alone', () => {
    expect(canonicalAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::')
    expect(canonicalAddress('2001:DB8:1:2::7')).toBe('2001:db8:1:2::')
    expect(canonicalAddress('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(canonicalAddress('2001:db8:1:2::1'))
    expect(canonicalAddress('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(canonicalAddress('::ffff:cb00:7109')).toBe('203.0.113.9')
    expect(canonicalAddress('203.0.113.9')).toBe('203.0.113.9')
    expect(canonicalAddress('unknown')).toBe('unknown')
    expect(canonicalAddress('<script>')).toBe('<script>')
    expect(canonicalAddress('::1')).toBe('0:0:0:0::')
  })

  it('pickClientIp applies it to every source, and ignores a duplicated X-Real-IP', () => {
    expect(pickClientIp({ realIp: '2001:db8:1:2::9', remote: '10.0.0.1', hops: 1 })).toBe('2001:db8:1:2::')
    expect(pickClientIp({ remote: '::ffff:203.0.113.9', hops: 0 })).toBe('203.0.113.9')
    expect(pickClientIp({ xff: '2001:db8:1:2::5, 84.17.44.225', remote: '10.0.0.1', hops: 2 })).toBe('2001:db8:1:2::')
    // two copies joined by the HTTP stack (a client copy and the edge's) are not one address: fall back to X-Forwarded-For
    expect(
      pickClientIp({ realIp: '9.9.9.9, 37.166.86.65', xff: '37.166.86.65, 84.17.44.225', remote: '10.0.0.1', hops: 1 }),
    ).toBe('84.17.44.225')
  })

  it('a host rotating through its /64 spends one sign-in budget, through the real route', async () => {
    r = await startRealRelay()
    const app = buildApp(r.relay.services)
    const seen: number[] = []
    for (let i = 0; i < 12; i++)
      seen.push(
        (
          await send(app, '/api/auth/login/options', {
            method: 'POST',
            headers: {
              Origin: 'https://relay.example.com',
              'X-Talos-CSRF': '1',
              'Content-Type': 'application/json',
              'X-Real-IP': `2001:db8:5:6:${i + 1}::${i + 1}`,
            },
            body: '{}',
          })
        ).status,
      )
    expect(seen.slice(0, 10).every((x) => x === 200)).toBe(true)
    expect(seen.slice(10).every((x) => x === 429)).toBe(true)
  })

  it('a flood of new keys cannot stall the limiter: the table stays bounded and the work stays linear', () => {
    let now = 1_000_000
    const lim = new RateLimiter({ now: () => now } as never)
    // What made a flood slow was O(n) work per new key: a full sweep, or a scan of the whole table to find what to evict.
    // No stopwatch. Every step the table's iterators take is counted (a sweep, an eviction walk and a scan all go through
    // them), and the total over the whole flood may be a few steps per key, not a table's worth per key. Going over stops
    // the flood at once rather than waiting out the slow run.
    const KEYS = 60_000
    const STEPS_PER_KEY = 4
    let steps = 0
    const spend = <T>(it: MapIterator<T>): MapIterator<T> => {
      const counted = function* () {
        for (const x of it) {
          if (++steps > STEPS_PER_KEY * KEYS) throw new Error(`the table walked ${steps} entries for ${KEYS} new keys`)
          yield x
        }
      }
      return counted() as unknown as MapIterator<T>
    }
    class CountingMap<K, V> extends Map<K, V> {
      override keys() {
        return spend(super.keys())
      }
      override values() {
        return spend(super.values())
      }
      override entries() {
        return spend(super.entries())
      }
      override [Symbol.iterator]() {
        return this.entries()
      }
      override forEach(fn: (v: V, k: K, m: Map<K, V>) => void) {
        for (const [k, v] of this.entries()) fn(v, k, this)
      }
    }
    const inner = lim as unknown as { buckets: Map<string, unknown>; sweep(n: number): void }
    inner.buckets = new CountingMap()
    const sweeps = vi.spyOn(inner, 'sweep')
    for (let i = 0; i < KEYS; i++) {
      expect(lim.take('auth', `k${i}`).ok).toBe(true) // 'auth' lasts a day, so nothing is old enough to sweep
      now += 1
    }
    expect(lim.size).toBeLessThanOrEqual(20_000)
    expect(steps).toBeGreaterThan(0) // control: the table was walked at all, so the count is wired to the real path
    // and full sweeps are rare: 60,000 keys one millisecond apart span a minute, and a sweep runs at most once per 30 s
    expect(sweeps.mock.calls.length).toBeGreaterThan(0) // control: the table did fill past the sweep threshold
    expect(sweeps.mock.calls.length).toBeLessThanOrEqual(3)
    // expired keys do get swept once a sweep is due
    now += 2 * 86_400_000
    lim.take('auth', 'late')
    expect(lim.size).toBeLessThan(20_000)
  })
})
