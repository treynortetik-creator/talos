// Re-check of PR #42 at aecc118 (review fixes): fresh bypass probes against the REAL relay (hub + FakeBridge/FakeApp).
import { request } from 'node:http'
import { newId } from '@talos-app/protocol'
import type { FakeBridge } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, PNG } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
})

const DEV = 'd_abcdefghijklmnopqrst'
const MIB = 1024 * 1024
const sess = () => ({ 'X-Test-Session': DEV, Origin: ORIGIN, 'X-Talos-CSRF': '1' })

function addDevice(r: TestRelay) {
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(DEV, 'phone', '{}', 'b', 1, 0, Date.now())
}
async function mint(r: TestRelay, scopes: string[]) {
  const res = await fetch(`${r.httpBase}/api/share/tokens`, {
    method: 'POST',
    headers: { ...sess(), 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'iPhone', scopes }),
  })
  return (await res.json()) as { token: { id: string }; secret: string }
}

/** Raw multipart POST with one ~`mb` MiB file; resolves with the status. */
function rawFileShare(r: TestRelay, secret: string, mb: number, ip: string): Promise<number> {
  const boundary = '----recheck'
  const file = Buffer.alloc(Math.floor(mb * MIB))
  Buffer.from(PNG).copy(file)
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, file, tail])
  const u = new URL(`${r.httpBase}/api/share`)
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
        'x-forwarded-for': ip,
      },
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('re-check at aecc118: fresh probes', () => {
  // N1 (V4.4 content box; same class as F1): the signed /share page row is a `message` frame, and hub.eventMessage
  // rebuilds it field by field without `share_content`. After a reload the owner's note is there and the material
  // he shared is gone from the thread (the bridge history keeps it; the relay buffer page does not).
  it('N1 a signed /share row keeps its share_content in the relay history page', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const app = await kit(relay).connectedApp()
    await app.sendMessage('general', 'summarise it', {
      share_content: { url: 'https://example.com/a', title: 'A page', text: 'the shared body' },
    })
    await new Promise((r) => setTimeout(r, 200))
    const reader = await kit(relay).connectedApp()
    reader.send({ type: 'history.request', request_id: 'h1', thread_id: 'general', limit: 20 })
    const page = await reader.expectFrame('history.page', (f) => f.request_id === 'h1', { direction: 'in' })
    const mine = (page.messages as Array<{ text?: string; share_content?: { text?: string } }>).find(
      (m) => m.text === 'summarise it',
    )
    expect(mine).toBeDefined()
    expect(mine?.share_content?.text).toBe('the shared body')
    await app.close()
    await reader.close()
  })

  // N2 (F3 fix, HOLDS): the budget is checked, then the handler awaits each file's arrayBuffer() before it records the bytes.
  // Concurrent posts that finish uploading together all pass the check. Bounded by in-flight requests (30/h/token).
  it('holds N2: concurrent file shares cannot overshoot the 200 MiB/day share budget', async () => {
    relay = await startTestRelay({ env: { TRUST_PROXY_HOPS: '1' } })
    addDevice(relay)
    const b = await kit(relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
    bridges.push(b)
    // 196 MiB of share bytes already today: room for exactly one more 3 MiB file
    relay.relay.services.db
      .prepare('insert into core_share_uploads (media_id, size, created_at) values (?, ?, ?)')
      .run(newId('md'), 196 * MIB, Date.now())
    const { secret } = await mint(relay, ['text', 'files'])
    const r = relay
    const statuses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => rawFileShare(r, secret, 3, `198.51.100.${i}`)),
    )
    const used = (
      relay.relay.services.db.prepare('select coalesce(sum(size),0) s from core_share_uploads').get() as { s: number }
    ).s
    expect(statuses.filter((s) => s === 202).length).toBeLessThanOrEqual(1)
    expect(used).toBeLessThanOrEqual(200 * MIB)
  })

  it('a file share stops at the owner daily upload budget set by MEDIA_DAILY_MAX_MB, not a fixed 200 MiB', async () => {
    relay = await startTestRelay({ env: { TRUST_PROXY_HOPS: '1', MEDIA_DAILY_MAX_MB: '5' } })
    addDevice(relay)
    const b = await kit(relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
    bridges.push(b)
    const { secret } = await mint(relay, ['text', 'files'])
    expect(await rawFileShare(relay, secret, 3, '198.51.100.1')).toBe(202)
    expect(await rawFileShare(relay, secret, 3, '198.51.100.2')).toBe(429) // 3 + 3 MiB is over the 5 MiB budget
  })

  it('holds: with SHARE_ENABLED=0, path variants are 404 too', async () => {
    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    const base = relay.httpBase
    for (const [method, path] of [
      ['GET', '/api/share/tokens/'],
      ['POST', '/api/share/'],
      ['GET', '/share-target'],
      ['POST', '/share-target/'],
      ['DELETE', '/api/share/tokens/sh_x/'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, redirect: 'manual' })
      expect([404, 405].includes(res.status) || res.status === 200, `${method} ${path} -> ${res.status}`).toBe(true)
      expect(res.status, `${method} ${path}`).not.toBe(401)
      expect(res.status, `${method} ${path}`).not.toBe(303)
    }
  })
})
