// MCP Apps AP2, the page route: PUT /bridge/media/:id with X-Talos-App-Csp and GET /media/:id/app (spec M3.5, M6.3).
// Everything goes through the real relay over HTTP; the app content is hostile, so the assertions are on the exact bytes
// of the headers and on what is (not) stored after a refusal.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildAppCsp, jcs, sha256Hex } from '@talos-app/protocol'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/migrate.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { bridgeFetch, PNG } from '../core/helpers.ts'
import { b64url, getApp, goodCsp, goodHeader, newMediaId, PAGE, putPage, SESSION, text } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})
const start = async () => (relay = await startTestRelay())
const mediaFiles = (r: TestRelay, id: string) => existsSync(join(r.dir, 'media', `${id}.bin`))

describe('GET /media/:id/app serves exactly the M3.5 headers', () => {
  it('real entry point: a stored app_csp gives the sandbox CSP, the policy builder output and the fixed headers', async () => {
    const r = await start()
    const id = newMediaId()
    expect((await putPage(r, id, { csp: goodHeader() })).status).toBe(200)
    const res = await getApp(r, id)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PAGE)
    const h = res.headers
    expect(h.get('content-type')).toBe('text/html; charset=utf-8')
    expect(h.get('content-security-policy')).toBe(`sandbox allow-scripts; ${buildAppCsp(goodCsp())}`)
    expect(h.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), fullscreen=()',
    )
    expect(h.get('referrer-policy')).toBe('no-referrer')
    expect(h.get('x-content-type-options')).toBe('nosniff')
    expect(h.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(h.get('cache-control')).toBe('private, no-store')
  })

  it('the policy has no unsafe-inline for scripts, no self, and an opaque origin (no allow-same-origin)', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const csp = (await getApp(r, id)).headers.get('content-security-policy') ?? ''
    expect(csp.startsWith('sandbox allow-scripts;')).toBe(true)
    expect(csp).not.toMatch(/allow-same-origin/)
    const script = csp.split('; ').find((d) => d.startsWith('script-src ')) ?? ''
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval|'self'|\*/)
    expect(script).toContain(`'sha256-${'A'.repeat(43)}='`)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('connect-src https://api.example.com')
  })

  it('an empty policy falls back to none for scripts, connect, frames and base-uri', async () => {
    const r = await start()
    const id = newMediaId()
    const empty = {
      ...goodCsp(),
      connect_domains: [],
      script_hashes: [],
      script_urls: [],
      style_urls: [],
      resource_domains: [],
    }
    expect((await putPage(r, id, { csp: goodHeader(empty) })).status).toBe(200)
    const csp = (await getApp(r, id)).headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
  })

  it('needs a session: no cookie is 401, the page is not served', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const res = await getApp(r, id, { Origin: 'https://relay.example.com' })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('<script>')
  })

  it('404 without an app_csp: an ordinary HTML upload, an unknown id, a malformed id, a PNG', async () => {
    const r = await start()
    const plain = newMediaId()
    expect((await putPage(r, plain)).status).toBe(200)
    expect((await getApp(r, plain)).status).toBe(404)
    expect((await getApp(r, newMediaId())).status).toBe(404)
    expect((await getApp(r, 'md_nope')).status).toBe(404)
    const png = newMediaId()
    await bridgeFetch(r, 'PUT', `/bridge/media/${png}`, PNG, { 'content-type': 'image/png' })
    expect((await getApp(r, png)).status).toBe(404)
  })

  it('every error body still carries a sandbox CSP', async () => {
    const r = await start()
    const res = await getApp(r, newMediaId())
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox/)
  })

  it('evicted: 410 with rehydrate, and the policy survives so a re-upload with the header serves again', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    await r.runtime.media.remove(id)
    const gone = await getApp(r, id)
    expect(gone.status).toBe(410)
    expect(await gone.json()).toEqual({ error: 'gone', rehydrate: true })
    expect((await putPage(r, id, { csp: goodHeader() })).status).toBe(200)
    expect((await getApp(r, id)).status).toBe(200)
  })

  it('a re-upload WITHOUT the header clears the policy: the page is no longer an app page', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    expect((await getApp(r, id)).status).toBe(200)
    await putPage(r, id)
    expect((await getApp(r, id)).status).toBe(404)
  })

  it('a re-upload with a different policy replaces it (the new one is served, not the old)', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const next = { ...goodCsp(), connect_domains: ['https://other.example.org'] }
    await putPage(r, id, { csp: goodHeader(next) })
    const csp = (await getApp(r, id)).headers.get('content-security-policy') ?? ''
    expect(csp).toContain('connect-src https://other.example.org')
    expect(csp).not.toContain('api.example.com')
  })
})

describe('PUT /bridge/media/:id with X-Talos-App-Csp refuses, and stores nothing when it does', () => {
  const refused = async (r: TestRelay, header: string | null, opts: { body?: Uint8Array; mime?: string } = {}) => {
    const id = newMediaId()
    const res = await putPage(r, id, { csp: header, ...opts })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('bad_app_csp')
    expect(r.runtime.store.getMediaRow(id)).toBeUndefined()
    expect(mediaFiles(r, id)).toBe(false)
    expect((await getApp(r, id)).status).toBe(404)
  }
  const enc = (c: unknown) => b64url(jcs(c))

  it('bad base64url, not JSON, JSON that is not a policy', async () => {
    const r = await start()
    await refused(r, '!!!not base64!!!')
    await refused(r, b64url('not json'))
    await refused(r, enc('a string'))
    await refused(r, enc([]))
    await refused(r, enc({}))
  })

  it('an empty header value', async () => {
    const r = await start()
    await refused(r, '')
  })

  it('an unknown key (strict) and a missing key', async () => {
    const r = await start()
    await refused(r, enc({ ...goodCsp(), extra: [] }))
    const { style_urls: _s, ...missing } = goodCsp()
    await refused(r, enc(missing))
  })

  it.each([
    ["'unsafe-eval'", { connect_domains: ["'unsafe-eval'"] }],
    ['*', { connect_domains: ['*'] }],
    ['*.com', { connect_domains: ['https://*.com'] }],
    ['http://', { connect_domains: ['http://api.example.com'] }],
    ['a path in a domain list', { connect_domains: ['https://api.example.com/v1'] }],
    ['a query in a pinned url', { script_urls: ['https://cdn.example.com/a.js?x=1'] }],
    ['a semicolon', { connect_domains: ['https://a.example.com;script-src *'] }],
    ['a quote', { connect_domains: ["https://a.example.com'"] }],
    ['17 entries', { connect_domains: Array.from({ length: 17 }, (_, i) => `https://h${i}.example.com`) }],
    ['a short script hash', { script_hashes: ['sha256-AAAA='] }],
  ])('rejects %s', async (_name, patch) => {
    const r = await start()
    await refused(r, enc({ ...goodCsp(), ...patch }))
  })

  it.each([
    ['the relay host', ['https://relay.example.com']],
    ['a wildcard covering the relay host', ['https://*.example.com']],
    ['the relay host with its port spelled out', ['https://relay.example.com:443']],
  ])('rejects %s in connect_domains (the app could reach the owner session)', async (_n, list) => {
    const r = await start()
    await refused(r, enc({ ...goodCsp(), connect_domains: list }))
  })

  it('rejects the relay host in a script URL and in a frame list too', async () => {
    const r = await start()
    await refused(r, enc({ ...goodCsp(), script_urls: ['https://relay.example.com/assets/x.js'] }))
    await refused(r, enc({ ...goodCsp(), frame_domains: ['https://relay.example.com'] }))
  })

  it('a header over 8,000 chars', async () => {
    const r = await start()
    await refused(r, 'A'.repeat(8_001))
  })

  it('two header values (comma-joined by the HTTP stack) are not a policy', async () => {
    const r = await start()
    const id = newMediaId()
    const res = await bridgeFetch(r, 'PUT', `/bridge/media/${id}`, PAGE, {
      'content-type': 'text/html',
    }) // control: plain upload works
    expect(res.status).toBe(200)
    const h = new Headers({ 'content-type': 'text/html' })
    h.append('x-talos-app-csp', goodHeader())
    h.append('x-talos-app-csp', goodHeader())
    const id2 = newMediaId()
    const two = await bridgeFetch(r, 'PUT', `/bridge/media/${id2}`, PAGE, Object.fromEntries(h))
    expect(two.status).toBe(400)
    expect(r.runtime.store.getMediaRow(id2)).toBeUndefined()
  })

  it('a body that is not HTML is refused even with a good policy (PNG, JSON, plain text), whatever Content-Type claims', async () => {
    const r = await start()
    await refused(r, goodHeader(), { body: PNG, mime: 'text/html' })
    await refused(r, goodHeader(), { body: text('{"a":1}'), mime: 'text/html' })
    await refused(r, goodHeader(), { body: text('just words'), mime: 'text/html' })
  })

  it('a page over 8 MiB with a policy is refused (an ordinary upload of that size is not)', async () => {
    const r = await start()
    const big = new Uint8Array(8 * 1024 * 1024 + 1).fill(0x20)
    big.set(text('<html><body>'), 0)
    const id = newMediaId()
    const res = await putPage(r, id, { body: big, csp: goodHeader() })
    expect(res.status).toBe(413)
    expect(r.runtime.store.getMediaRow(id)).toBeUndefined()
    const ok = newMediaId()
    expect((await putPage(r, ok, { body: big })).status).toBe(200) // control: the cap is the app page's, not the relay's
  })

  it('an unsigned or wrongly signed PUT with a policy stores nothing', async () => {
    const r = await start()
    const id = newMediaId()
    const res = await fetch(`${r.httpBase}/bridge/media/${id}`, {
      method: 'PUT',
      body: PAGE as BodyInit,
      headers: { 'content-type': 'text/html', 'x-talos-app-csp': goodHeader() },
    })
    expect(res.status).toBe(401)
    expect(r.runtime.store.getMediaRow(id)).toBeUndefined()
  })

  it('a sha256 mismatch with a good policy stores nothing', async () => {
    const r = await start()
    const id = newMediaId()
    const res = await bridgeFetch(r, 'PUT', `/bridge/media/${id}`, PAGE, {
      'content-type': 'text/html',
      'x-talos-sha256': 'e'.repeat(64),
      'x-talos-app-csp': goodHeader(),
    })
    expect(res.status).toBe(400)
    expect(r.runtime.store.getMediaRow(id)).toBeUndefined()
  })
})

describe('an app page is only ever served under its approved policy', () => {
  it('/media/:id/page (inline scripts allowed) 404s for an app page; an ordinary HTML page still works there', async () => {
    const r = await start()
    const app = newMediaId()
    const plain = newMediaId()
    await putPage(r, app, { csp: goodHeader() })
    await putPage(r, plain)
    const viaPage = await fetch(`${r.httpBase}/media/${app}/page`, { headers: SESSION })
    expect(viaPage.status).toBe(404)
    expect(await viaPage.text()).not.toContain('<script>')
    expect((await fetch(`${r.httpBase}/media/${plain}/page`, { headers: SESSION })).status).toBe(200)
  })

  it('/media/:id (raw download) of an app page is the script-free attachment policy, not the app policy', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const raw = await fetch(`${r.httpBase}/media/${id}`, { headers: SESSION })
    expect(raw.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
    )
    expect(raw.headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  it('a stored policy that no longer opens or parses fails closed: 404, never the page', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    expect((await getApp(r, id)).status).toBe(200)
    r.runtime.store.db.prepare('update core_media set app_csp = ? where media_id = ?').run(Buffer.from('garbage'), id)
    expect((await getApp(r, id)).status).toBe(404)
  })

  it('the policy is encrypted at rest (no domain appears in the database file)', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const blob = r.runtime.store.db.prepare('select app_csp from core_media where media_id = ?').get(id) as {
      app_csp: Buffer
    }
    expect(Buffer.isBuffer(blob.app_csp)).toBe(true)
    expect(blob.app_csp.toString('latin1')).not.toContain('example.com')
  })

  it('two uploads of the same id at once end as one whole policy or none, never a mix', async () => {
    const r = await start()
    const id = newMediaId()
    const a = goodHeader({ ...goodCsp(), connect_domains: ['https://a.example.org'] })
    const b = goodHeader({ ...goodCsp(), connect_domains: ['https://b.example.org'] })
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) => putPage(r, id, i % 3 === 2 ? {} : { csp: i % 2 ? a : b })),
    )
    expect(res.every((x) => x.status === 200)).toBe(true)
    const got = await getApp(r, id)
    if (got.status === 200) {
      const csp = got.headers.get('content-security-policy') ?? ''
      const hasA = csp.includes('https://a.example.org')
      const hasB = csp.includes('https://b.example.org')
      expect(hasA !== hasB).toBe(true)
    } else expect(got.status).toBe(404)
  })

  it('sha256 of what is served is what was uploaded (the page is not rewritten)', async () => {
    const r = await start()
    const id = newMediaId()
    await putPage(r, id, { csp: goodHeader() })
    const served = new Uint8Array(await (await getApp(r, id)).arrayBuffer())
    expect(sha256Hex(served)).toBe(sha256Hex(PAGE))
  })
})

describe('migration 0002 (older data, older peers)', () => {
  it('adds a nullable app_csp to a database that already has media rows: they read as non-app pages', () => {
    const db = new Database(':memory:')
    migrate(db, { modules: ['core'], dir: partialDir() })
    db.prepare(
      "insert into core_media (media_id, mime, name, size, sha256, kind, origin, evicted, created_at) values ('md_X', 'text/html', 'n', 1, 'h', 'html', 'bridge', 0, 1)",
    ).run()
    const applied = migrate(db)
    expect(applied.map((m) => `${m.module}/${m.name}`)).toContain('core/0002_app_csp')
    expect(
      (db.prepare("select app_csp from core_media where media_id = 'md_X'").get() as { app_csp: unknown }).app_csp,
    ).toBeNull()
    expect(migrate(db)).toEqual([]) // idempotent
  })

  it('an older build (insert without the column) still writes rows on the new schema', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare(
      "insert or replace into core_media (media_id, mime, name, size, sha256, kind, origin, duration_ms, evicted, created_at) values ('md_Y', 'image/png', 'n', 1, 'h', 'image', 'app', null, 0, 1)",
    ).run()
    expect(db.prepare('select count(*) c from core_media where app_csp is null').get()).toEqual({ c: 1 })
  })
})

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DEFAULT_MIGRATIONS_DIR } from '../../src/migrate.ts'

/** The shipped migrations minus 0002: the database as it was before AP2. */
function partialDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'talos-mig-'))
  cpSync(join(DEFAULT_MIGRATIONS_DIR, 'core'), join(dir, 'core'), { recursive: true })
  rmSync(join(dir, 'core', '0002_app_csp.sql'))
  return dir
}
