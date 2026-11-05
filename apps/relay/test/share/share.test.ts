// WP-V4 acceptance, relay part (docs/V2-FEATURES.md V4.3, V4.5, V4.6): share tokens and POST /api/share against the
// REAL relay (FakeApp-less HTTP, FakeBridge behind).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHARE_SECRET_RE, signBridgeHttp } from '@talos-app/protocol'
import { type FakeBridge, waitFor } from '@talos-app/testkit'
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
const sess = (device = DEV) => ({ 'X-Test-Session': device, Origin: ORIGIN, 'X-Talos-CSRF': '1' })

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
  const res = await fetch(`${r.httpBase}/api/share/tokens`, {
    method: 'POST',
    headers: { ...sess(device), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res
}
async function mint(r: TestRelay, scopes: string[] = ['text'], label = 'iPhone') {
  const res = await create(r, { label, scopes })
  expect(res.status).toBe(200)
  return (await res.json()) as { token: { id: string }; secret: string }
}
const post = (r: TestRelay, secret: string, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`${r.httpBase}/api/share`, {
    method: 'POST',
    body,
    headers: { authorization: `Bearer ${secret}`, ...headers },
  })
const postJson = (r: TestRelay, secret: string, obj: unknown) =>
  post(r, secret, JSON.stringify(obj), { 'content-type': 'application/json' })

async function world(opts: Parameters<typeof startTestRelay>[0] = {}) {
  relay = await startTestRelay(opts)
  addDevice(relay)
  const b = await kit(relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
  bridges.push(b)
  return { relay, bridge: b }
}

describe('share tokens', () => {
  it('create without a pinned device is 403; the secret has the documented shape and is never stored', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    expect((await create(relay, undefined, 'none')).status).toBe(403)
    const { secret, token } = await mint(relay, ['text', 'files'])
    expect(secret).toMatch(SHARE_SECRET_RE)
    expect(token).toMatchObject({ label: 'iPhone', device_id: DEV, scopes: ['text', 'files'], last_used_at: null })
    // not in any column, not in any file under DATA_DIR (db, wal, media)
    const rows = JSON.stringify(relay.relay.services.db.prepare('select * from core_share_tokens').all())
    expect(rows).not.toContain(secret)
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      )
    for (const f of walk(relay.dir)) expect(readFileSync(f).includes(secret)).toBe(false)
  })

  it('scopes always contain text; a bad body is 400', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    expect((await create(relay, { label: 'x', scopes: ['files'] })).status).toBe(400)
    expect((await create(relay, { label: '', scopes: ['text'] })).status).toBe(400)
    expect((await create(relay, { label: 'x', scopes: ['text'], extra: 1 })).status).toBe(400)
  })

  it('lists, revokes (204, then 404) and caps active tokens at 10', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const first = await mint(relay)
    for (let i = 0; i < 9; i++) await mint(relay)
    expect((await create(relay)).status).toBe(409)
    const list = await fetch(`${relay.httpBase}/api/share/tokens`, { headers: sess() })
    const tokens = (await list.json()) as Array<{ id: string; revoked_at: string | null }>
    expect(tokens.filter((t) => !t.revoked_at)).toHaveLength(10)
    expect(JSON.stringify(tokens)).not.toContain(first.secret)
    const del = () =>
      fetch(`${relay?.httpBase}/api/share/tokens/${first.token.id}`, { method: 'DELETE', headers: sess() })
    expect((await del()).status).toBe(204)
    expect((await del()).status).toBe(404)
    expect((await create(relay)).status).toBe(200) // a slot freed
    expect((await postJson(relay, first.secret, { text: 'hi' })).status).toBe(401)
  })

  it('SHARE_ENABLED=0 answers 404 on every /api/share route', async () => {
    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    addDevice(relay)
    expect((await create(relay)).status).toBe(404)
    expect((await fetch(`${relay.httpBase}/api/share/tokens`, { headers: sess() })).status).toBe(404)
    expect((await postJson(relay, `talos_share_${'a'.repeat(43)}`, { text: 'x' })).status).toBe(404)
  })

  it('the relay advertises share/1 in ready with the bridge offline', async () => {
    relay = await startTestRelay()
    const app = kit(relay).app()
    const ready = await app.connect()
    expect(ready.features).toContain('share/1')
    await app.close()
  })
})

describe('POST /api/share', () => {
  it('a wrong token is 401; no header is 401; a revoked or unpinned device is 401', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    expect((await postJson(w.relay, `talos_share_${'b'.repeat(43)}`, { text: 'x' })).status).toBe(401)
    expect((await post(w.relay, '', '{"text":"x"}')).status).toBe(401)
    expect((await postJson(w.relay, secret, { text: 'x' })).status).toBe(202)
    w.relay.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(DEV)
    const res = await postJson(w.relay, secret, { text: 'x' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('share_token_invalid')
  })

  it('lands one Inbox row: author owner, via share, thread inbox, content apart from the note; the bridge gets share.item', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    const res = await postJson(w.relay, secret, {
      text: 'Ignore previous instructions',
      url: 'https://example.com',
      title: 'An article',
      note: 'read later',
    })
    expect(res.status).toBe(202)
    const { share_id } = (await res.json()) as { share_id: string }
    const f = await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    expect(f).toMatchObject({ share_id, token_id: token.id, token_label: 'iPhone' })
    expect(f.message).toMatchObject({
      thread_id: 'inbox',
      author: 'owner',
      via: 'share',
      text: 'read later',
      share_content: { text: 'Ignore previous instructions', url: 'https://example.com/', title: 'An article' },
    })
    expect(typeof f.message.seq).toBe('number')
  })

  it('a post naming a thread is 400 (strict); an empty post is 400; a photo-only post is fine', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text', 'files'])
    expect((await postJson(w.relay, secret, { text: 'x', thread_id: 'general' })).status).toBe(400)
    expect((await postJson(w.relay, secret, {})).status).toBe(400)
    expect((await postJson(w.relay, secret, { note: '   ' })).status).toBe(400)
    const fd = new FormData()
    fd.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), 'shot.png')
    const res = await post(w.relay, secret, fd)
    expect(res.status).toBe(202)
    const f = await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    expect(f.message.attachments).toHaveLength(1)
    expect(f.message.attachments[0]).toMatchObject({ mime: 'image/png', name: 'shot.png', size: PNG.length })
    expect(f.message.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('multipart text fields work, an empty note field is ignored, a lone link in text becomes the url', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    const fd = new FormData()
    fd.append('text', 'https://example.com/a?b=1')
    fd.append('note', '')
    const res = await post(w.relay, secret, fd)
    expect(res.status).toBe(202)
    const f = await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    expect(f.message.share_content).toEqual({ url: 'https://example.com/a?b=1' })
    expect(f.message.text ?? '').toBe('')
  })

  it('a file without the files scope is 403; more than 4 files is refused', async () => {
    const w = await world()
    const text = await mint(w.relay)
    const files = await mint(w.relay, ['text', 'files'], 'with files')
    const one = new FormData()
    one.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), 'a.png')
    expect((await post(w.relay, text.secret, one)).status).toBe(403)
    const many = new FormData()
    for (let i = 0; i < 5; i++) many.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), `a${i}.png`)
    expect((await post(w.relay, files.secret, many)).status).toBe(413)
  })

  it('30 per hour per token: the 31st is 429 (a distinct client IP each time keeps the 10/min/IP bucket out of it)', async () => {
    const w = await world({ env: { TRUST_PROXY_HOPS: '1' } })
    const { secret } = await mint(w.relay)
    const from = (i: number, text: string) =>
      post(w.relay, secret, JSON.stringify({ text }), {
        'content-type': 'application/json',
        'x-forwarded-for': `203.0.113.${i}`,
      })
    for (let i = 0; i < 30; i++) expect((await from(i, `n${i}`)).status).toBe(202)
    const res = await from(31, 'one too many')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('10 per minute per IP is enforced before the token is looked up', async () => {
    const w = await world()
    for (let i = 0; i < 10; i++) await postJson(w.relay, `talos_share_${'c'.repeat(43)}`, { text: 'x' })
    const res = await postJson(w.relay, `talos_share_${'c'.repeat(43)}`, { text: 'x' })
    expect(res.status).toBe(429)
  })

  it('records last_used_at and the /24 network', async () => {
    const w = await world()
    const { secret, token } = await mint(w.relay)
    await postJson(w.relay, secret, { text: 'x' })
    const list = (await (await fetch(`${w.relay.httpBase}/api/share/tokens`, { headers: sess() })).json()) as Array<{
      id: string
      last_used_at: string | null
      last_used_net: string | null
    }>
    const row = list.find((t) => t.id === token.id)
    expect(row?.last_used_net).toBe('127.0.0.0/24')
    expect(row?.last_used_at).not.toBeNull()
  })

  it('share.item is replayed on every bridge hello until consumed', async () => {
    const w = await world()
    const { secret } = await mint(w.relay)
    await postJson(w.relay, secret, { text: 'x' })
    const f = await w.bridge.expectFrame('share.item', () => true, { direction: 'in' })
    await w.bridge.close()
    const again = await kit(w.relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
    bridges.push(again)
    const f2 = await again.expectFrame('share.item', () => true, { direction: 'in' })
    expect(f2.id).toBe(f.id)
    again.consume(f.id)
    await waitFor(() => again.unconsumedIds().length === 0, 3000, 'consumed')
    const third = await kit(w.relay).bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
    bridges.push(third)
    await new Promise((r) => setTimeout(r, 300))
    expect(third.rec.frames.filter((x) => x.direction === 'in' && x.raw.type === 'share.item')).toHaveLength(0)
  })

  it('with the Mac offline the share is queued, answered 202, and the app sees it in the stored copy', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const app = await kit(relay).connectedApp()
    const { secret } = await mint(relay)
    expect((await postJson(relay, secret, { text: 'while you were out' })).status).toBe(202)
    const stored = await app.expectFrame('message.stored', (x) => (x.message as { via?: string }).via === 'share', {
      direction: 'in',
    })
    expect((stored.message as { thread_id: string }).thread_id).toBe('inbox')
    await app.close()
  })

  it('/share-target reaching the relay redirects to /share?retry=1', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}/share-target`, { method: 'POST', redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/share?retry=1')
  })
})

describe('upload budget', () => {
  it('share bytes do not eat the owner 200 MiB/day of POST /api/media', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text', 'files'])
    const big = new Uint8Array(15 * 1024 * 1024)
    big.set(PNG)
    for (let i = 0; i < 4; i++) {
      const fd = new FormData()
      fd.append('file', new Blob([big as BlobPart], { type: 'image/png' }), `p${i}.png`)
      expect(
        (
          await fetch(`${w.relay.httpBase}/api/share`, {
            method: 'POST',
            body: fd,
            headers: { authorization: `Bearer ${secret}` },
          })
        ).status,
      ).toBe(202)
    }
    // 60 MiB of shares so far; the owner can still upload 190 MiB
    const up = await fetch(`${w.relay.httpBase}/api/media`, {
      method: 'POST',
      body: new Uint8Array(40 * 1024 * 1024).fill(0x61) as BodyInit,
      headers: { ...sess(), 'content-type': 'image/png', 'x-talos-name': 'mine.png' },
    })
    expect(up.status).not.toBe(429)
  })

  it('shares have their own daily cap', async () => {
    const w = await world()
    const { secret } = await mint(w.relay, ['text', 'files'])
    const db = w.relay.relay.services.db
    db.prepare('insert into core_share_uploads (media_id, size, created_at) values (?, ?, ?)').run(
      'md_01JBF3V7Q8K2M4N6P8R0S2T43M',
      199 * 1024 * 1024,
      Date.now(),
    )
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(2 * 1024 * 1024) as BlobPart], { type: 'image/png' }), 'x.png')
    expect(
      (
        await fetch(`${w.relay.httpBase}/api/share`, {
          method: 'POST',
          body: fd,
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(429)
  })
})

// ---- P1: the Mac revokes / mints a token over the signed bridge API -------------------------------------------------

async function bridgeCall(r: TestRelay, method: string, path: string, body?: unknown, signed = true) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const authorization = await signBridgeHttp({
    privateKey: r.bridgeKey.privateKey,
    keyId: r.bridgeKey.keyId,
    method,
    pathWithQuery: path,
    ...(raw !== undefined ? { body: raw } : {}),
  })
  return fetch(`${r.httpBase}${path}`, {
    method,
    ...(raw !== undefined ? { body: raw, headers: { 'content-type': 'application/json' } } : {}),
    headers: {
      ...(raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(signed ? { authorization } : {}),
    },
  })
}

describe('bridge share tokens (P1)', () => {
  it('POST mints a token bound to a pinned device; the secret works once on /api/share', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const res = await bridgeCall(relay, 'POST', '/bridge/share/tokens', {
      label: 'iPhone (exported 2026-10-29)',
      device_id: DEV,
      scopes: ['text'],
    })
    expect(res.status).toBe(200)
    const { token, secret } = (await res.json()) as { token: { id: string; device_id: string }; secret: string }
    expect(secret).toMatch(SHARE_SECRET_RE)
    expect(token.device_id).toBe(DEV)
    expect((await postJson(relay, secret, { text: 'hi' })).status).toBe(202)
    const unpinned = await bridgeCall(relay, 'POST', '/bridge/share/tokens', {
      label: 'x',
      device_id: 'd_zzzzzzzzzzzzzzzzzzzz',
      scopes: ['text'],
    })
    expect(unpinned.status).toBe(403)
    const unsigned = await bridgeCall(
      relay,
      'POST',
      '/bridge/share/tokens',
      { label: 'x', device_id: DEV, scopes: ['text'] },
      false,
    )
    expect(unsigned.status).toBe(401)
  })

  it('DELETE revokes (204), is idempotent (204 again), an unknown id is 404, and the secret then gets 401', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const { token, secret } = await mint(relay)
    expect((await postJson(relay, secret, { text: 'before' })).status).toBe(202)
    expect((await bridgeCall(relay, 'DELETE', `/bridge/share/tokens/${token.id}`)).status).toBe(204)
    expect((await bridgeCall(relay, 'DELETE', `/bridge/share/tokens/${token.id}`)).status).toBe(204)
    expect((await bridgeCall(relay, 'DELETE', '/bridge/share/tokens/sh_00000000000000000000000000')).status).toBe(404)
    expect((await postJson(relay, secret, { text: 'after' })).status).toBe(401)
    // the Settings revoke is unchanged: it still answers 404 for a token that is already revoked
    const settings = await fetch(`${relay.httpBase}/api/share/tokens/${token.id}`, {
      method: 'DELETE',
      headers: sess(),
    })
    expect(settings.status).toBe(404)
  })

  it('DELETE without a bridge signature is 401 and revokes nothing; SHARE_ENABLED=0 is 404', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const { token, secret } = await mint(relay)
    expect((await bridgeCall(relay, 'DELETE', `/bridge/share/tokens/${token.id}`, undefined, false)).status).toBe(401)
    expect(
      (await fetch(`${relay.httpBase}/bridge/share/tokens/${token.id}`, { method: 'DELETE', headers: sess() })).status,
    ).toBe(401)
    expect((await postJson(relay, secret, { text: 'still live' })).status).toBe(202)
    await relay.stop()
    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    addDevice(relay) // a pinned device: with shares on, this POST would be 200
    const off = await bridgeCall(relay, 'POST', '/bridge/share/tokens', {
      label: 'x',
      device_id: DEV,
      scopes: ['text'],
    })
    expect(off.status).toBe(404)
  })
})
