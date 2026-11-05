// Adversarial review of PR #42 (WP-V4 share), relay part. REAL relay hub + FakeBridge/FakeApp over real sockets and
// real HTTP. Every test in the first describe FAILS on the PR head (dc22c74) and names the spec line it holds the code to.
// The second describe holds probes that passed; they stay as guards.
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
const DEV2 = 'd_zyxwvutsrqponmlkjihg'
const sess = (device = DEV) => ({ 'X-Test-Session': device, Origin: ORIGIN, 'X-Talos-CSRF': '1' })
const MIB = 1024 * 1024

function addDevice(r: TestRelay, id = DEV, o: { pinned?: number; revoked?: number } = {}) {
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'phone', '{}', 'b', o.pinned ?? 1, o.revoked ?? 0, Date.now())
}

async function create(
  r: TestRelay,
  body: Record<string, unknown> = { label: 'iPhone', scopes: ['text'] },
  device = DEV,
) {
  return fetch(`${r.httpBase}/api/share/tokens`, {
    method: 'POST',
    headers: { ...sess(device), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function mint(r: TestRelay, scopes: string[] = ['text'], device = DEV) {
  const res = await create(r, { label: 'iPhone', scopes }, device)
  expect(res.status).toBe(200)
  return (await res.json()) as { token: { id: string }; secret: string }
}
const postJson = (r: TestRelay, secret: string, obj: unknown) =>
  fetch(`${r.httpBase}/api/share`, {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  })

async function world(opts: Parameters<typeof startTestRelay>[0] = {}) {
  relay = await startTestRelay(opts)
  addDevice(relay)
  const b = await kit(relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
  bridges.push(b)
  return { relay, bridge: b }
}

/**
 * Opens a raw multipart POST to /api/share, sends the headers and the first half of the body, and returns a function
 * that sends the rest and resolves with the status. The token is checked on the headers; the body arrives later.
 */
function slowShare(r: TestRelay, secret: string, text: string) {
  const boundary = '----talosreview'
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  )
  const u = new URL(`${r.httpBase}/api/share`)
  let status: Promise<number> = Promise.resolve(0)
  const req = request({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
  })
  status = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
  })
  const half = Math.floor(body.length / 2)
  req.write(body.subarray(0, half))
  return async () => {
    req.end(body.subarray(half))
    return status
  }
}

describe('FAILS on PR #42: findings', () => {
  // F1 (V4.4, V4.6 "Rows"): a token share is an Inbox row the owner is meant to SEE. The relay's history.page builder
  // (hub.eventMessage) drops every `message.stored` whose author is `owner`, and the share row is built as author owner,
  // so after a reload (or on a second device) the share is gone from Inbox whenever the relay answers from its buffer.
  it('F1 a token share is in the Inbox history page the relay serves to the app', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    expect((await postJson(w.relay, secret, { text: 'an article to read', note: 'later' })).status).toBe(202)
    await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    const app = await kit(w.relay).connectedApp()
    app.send({ type: 'history.request', request_id: 'h1', thread_id: 'inbox', limit: 20 })
    const page = await app.expectFrame('history.page', (f) => f.request_id === 'h1', { direction: 'in' })
    const messages = page.messages as Array<{ via?: string; share_content?: { text?: string } }>
    expect(messages.some((m) => m.via === 'share' && m.share_content?.text === 'an article to read')).toBe(true)
    await app.close()
  })

  // F2 (V4.3 "revocable", V4.7 "until the owner revokes it"): the token is checked on the headers, then the handler
  // waits up to 60 s for the body. A revoke (or a device revoke) that lands in that window does not stop the share.
  it('F2 a token revoked while its POST body is still uploading does not land a row', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    const finish = slowShare(w.relay, secret, 'sent after the revoke')
    await new Promise((r) => setTimeout(r, 150)) // headers are in: shareAuth has passed
    const del = await fetch(`${w.relay.httpBase}/api/share/tokens/${token.id}`, { method: 'DELETE', headers: sess() })
    expect(del.status).toBe(204)
    const status = await finish()
    expect(status).toBe(401)
    await new Promise((r) => setTimeout(r, 300))
    expect(w.bridge.rec.frames.filter((f) => f.direction === 'in' && f.raw.type === 'share.item')).toHaveLength(0)
  })

  it('F2b a device revoked while its token POST is uploading does not land a row', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const finish = slowShare(w.relay, secret, 'sent after the device revoke')
    await new Promise((r) => setTimeout(r, 150))
    w.relay.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(DEV)
    expect(await finish()).toBe(401)
  })

  // F3 (V7 "Worst case: untrusted rows in Inbox"): the owner's own /api/media route stops at 200 MiB of uploads per
  // day (store.uploadedBytesSince). POST /api/share saves files through the same media store with origin 'app' and
  // never checks that budget, so a leaked files token can fill the relay volume (30/h x 80 MB = 2.4 GB/h) and, because
  // its bytes count toward the same budget, lock the owner out of his own uploads for a day.
  it('F3 a files share is refused once the 200 MiB/day upload budget is spent', async () => {
    const w = await world()
    const store = w.relay.relay.services.db
    // 199.9 MiB of app uploads already today (rows only; the budget is computed from core_media sizes)
    store
      .prepare(
        "insert into core_media (media_id, mime, name, size, sha256, kind, origin, duration_ms, evicted, created_at) values (?, 'image/png', 'x', ?, ?, 'image', 'app', null, 0, ?)",
      )
      .run(newId('md'), Math.floor(199.9 * MIB), 'ab'.repeat(32), Date.now())
    const { secret } = await mint(w.relay, ['text', 'files'])
    const fd = new FormData()
    const big = new Uint8Array(MIB)
    big.set(PNG)
    fd.append('file', new Blob([big as BlobPart], { type: 'image/png' }), 'big.png')
    const res = await fetch(`${w.relay.httpBase}/api/share`, {
      method: 'POST',
      body: fd,
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(res.status).toBe(429)
  })

  // F4 (V4.6 "SHARE_ENABLED=0 -> 404"; owner: "must really give a 404 everywhere"). requireSession runs before the off
  // check, so the token routes answer 401 to a caller without a session, and /share-target still answers 303.
  it('F4 SHARE_ENABLED=0: every share route is 404, with or without a session', async () => {
    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    addDevice(relay)
    const r = relay
    const noSess = { Origin: ORIGIN, 'X-Talos-CSRF': '1' }
    expect((await fetch(`${r.httpBase}/api/share/tokens`)).status).toBe(404)
    expect(
      (
        await fetch(`${r.httpBase}/api/share/tokens`, {
          method: 'POST',
          headers: { ...noSess, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404)
    expect((await fetch(`${r.httpBase}/api/share/tokens/sh_x`, { method: 'DELETE', headers: noSess })).status).toBe(404)
    const st = await fetch(`${r.httpBase}/share-target`, { method: 'POST', redirect: 'manual' })
    expect(st.status).toBe(404)
  })

  // F5 (V4.3 "10 active per relay"): a token whose device was revoked can never work again (the lookup join), but it
  // still has revoked_at null, so it is listed as live and holds one of the 10 slots. Lose a phone with 10 links and
  // the new phone cannot create one until the owner revokes ten dead rows by hand.
  it('F5 tokens of a revoked device are not "active": they free their slots and are not listed as live', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    addDevice(relay, DEV2)
    for (let i = 0; i < 10; i++) await mint(relay)
    relay.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(DEV)
    const list = (await (await fetch(`${relay.httpBase}/api/share/tokens`, { headers: sess(DEV2) })).json()) as Array<{
      device_id: string
    }>
    expect(list.filter((t) => t.device_id === DEV)).toHaveLength(0)
    expect((await create(relay, { label: 'new phone', scopes: ['text'] }, DEV2)).status).toBe(200)
  })
})

describe('holds on PR #42: guards', () => {
  it('concurrent creates cannot exceed the cap of 10', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const r = relay
    const all = await Promise.all(Array.from({ length: 25 }, () => create(r)))
    expect(all.filter((x) => x.status === 200)).toHaveLength(10)
    expect(all.filter((x) => x.status === 409)).toHaveLength(15)
  })

  it('a token from another device cannot be minted by a session whose device is unpinned', async () => {
    relay = await startTestRelay()
    addDevice(relay, DEV2, { pinned: 0 })
    expect((await create(relay, undefined, DEV2)).status).toBe(403)
  })

  it('without a valid token the body is never read: a 50 MB body to a bad token is answered 401 before it is sent', async () => {
    const w = await world()
    const url = new URL(`${w.relay.httpBase}/api/share`)
    // The request claims 50 MB and sends 1 KiB, then waits. A server that read or parsed the body before checking the
    // token would wait for the rest and never answer; one that checks the token first answers now. No stopwatch: the
    // answer arriving while the body is still unsent is the proof.
    const status = await new Promise<number | 'closed'>((resolve) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            authorization: `Bearer talos_share_${'z'.repeat(43)}`,
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(50 * MIB),
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0)
          res.resume()
          req.destroy()
        },
      )
      req.on('error', () => resolve('closed'))
      req.write(Buffer.alloc(1024))
    })
    expect(status).toBe(401)
  })

  it('a text-only token cannot push a large body (128 KiB cap) and cannot name extra fields', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    expect((await postJson(w.relay, secret, { text: 'x'.repeat(200_000) })).status).toBe(413)
    const fd = new FormData()
    fd.append('text', 'x')
    fd.append('thread_id', 'general')
    expect(
      (
        await fetch(`${w.relay.httpBase}/api/share`, {
          method: 'POST',
          body: fd,
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(400)
  })

  it('multipart: traversal names are cut to a base name, MIME is sniffed not trusted, empty parts do not count', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text', 'files'])
    const fd = new FormData()
    fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), '../../../etc/passwd.png')
    for (let i = 0; i < 50; i++) fd.append('file', new Blob([]), `empty${i}`)
    const res = await fetch(`${w.relay.httpBase}/api/share`, {
      method: 'POST',
      body: fd,
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(res.status).toBe(202)
    const f = await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    const att = (f.message as { attachments: Array<{ name: string; mime: string }> }).attachments
    expect(att).toHaveLength(1)
    expect(att[0]?.name).toBe('passwd.png')
    expect(att[0]?.mime).toBe('text/html') // sniffed; /media serves it as an attachment under the sandbox CSP
  })

  it('a zip is stored as an opaque attachment (never expanded) and a 21 MB file is 413', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text', 'files'])
    const zip = new Uint8Array(1024)
    zip.set([0x50, 0x4b, 0x03, 0x04])
    const ok = new FormData()
    ok.append('file', new Blob([zip as BlobPart], { type: 'application/zip' }), 'bomb.zip')
    expect(
      (
        await fetch(`${w.relay.httpBase}/api/share`, {
          method: 'POST',
          body: ok,
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(202)
    const big = new FormData()
    big.append('file', new Blob([new Uint8Array(21 * MIB) as BlobPart]), 'big.bin')
    expect(
      (
        await fetch(`${w.relay.httpBase}/api/share`, {
          method: 'POST',
          body: big,
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(413)
  })
})
