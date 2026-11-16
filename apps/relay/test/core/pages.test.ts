// Org pages, phase 1, against the REAL relay (docs/ORG-PAGES-SPEC.md): only the bridge's signature publishes; versions are
// named by their bytes and capped at 10; the store's caps answer 507 pages_full; the frame carries the exact page policy and
// is the owner's alone; a page that is missing, malformed or not this thread's looks exactly the same; the owner's changes
// are device-signed; the sweeper ends shares past their end.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appCsp,
  createDeviceKey,
  type DeviceKey,
  generateBridgeKey,
  newUlid,
  PAGE_CSP,
  PAGE_LIMITS,
  PAGE_SANDBOX_ATTR,
  PAGES_FULL,
  type PageInfoT,
  type PageListT,
  signOwnerFrame,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sweepPages } from '../../src/core/pages-store.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { bridgeFetch } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const THREAD = 'trip'
const html = (n: number | string) => `<!doctype html><title>t</title><p>version ${n}</p>`

async function world(opts: Parameters<typeof startTestRelay>[0] = {}) {
  const r = await startTestRelay(opts)
  relay = r
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  return { r, dev }
}

const sha = async (s: string | Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest('SHA-256', typeof s === 'string' ? new TextEncoder().encode(s) : (s as BufferSource)),
  ).toString('hex')

async function publish(
  r: TestRelay,
  body: string | Uint8Array,
  q: { thread_id?: string; title?: string; page_id?: string } = {},
) {
  const qs = new URLSearchParams({ thread_id: q.thread_id ?? THREAD, title: q.title ?? 'Rota', ...q })
  if (q.page_id === undefined) qs.delete('page_id')
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return bridgeFetch(r, 'POST', `/bridge/pages?${qs}`, bytes, {
    'content-type': 'text/html; charset=utf-8',
    'x-talos-sha256': await sha(bytes),
  })
}

const owner = (dev: DeviceKey) => ({
  'X-Test-Session': dev.deviceId,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})
const get = (r: TestRelay, path: string, h: Record<string, string> = {}) =>
  fetch(`${r.httpBase}${path}`, { headers: h, redirect: 'manual' })

async function act(
  r: TestRelay,
  dev: DeviceKey,
  pageId: string,
  type: 'page.share' | 'page.unshare' | 'page.current' | 'page.delete',
  over: Record<string, unknown> = {},
  signer: DeviceKey = dev,
) {
  const frame = await signOwnerFrame(
    {
      v: 1,
      type,
      device_id: dev.deviceId,
      page_id: pageId,
      ts: new Date(r.relay.services.clock.now()).toISOString(),
      nonce: newUlid().toLowerCase(),
      ...over,
    },
    signer.privateKey,
  )
  const path = { 'page.share': 'share', 'page.unshare': 'unshare', 'page.current': 'current', 'page.delete': '' }[type]
  return fetch(`${r.httpBase}/api/pages/${pageId}${path ? `/${path}` : ''}`, {
    method: type === 'page.delete' ? 'DELETE' : 'POST',
    headers: owner(dev),
    body: JSON.stringify(frame),
  })
}

const pageRows = (r: TestRelay) =>
  (r.relay.services.db.prepare('select count(*) n from core_pages').get() as { n: number }).n
const versionRows = (r: TestRelay, id: string) =>
  r.relay.services.db.prepare('select hash from core_page_versions where page_id = ? order by created_at').all(id) as {
    hash: string
  }[]

describe('publishing (the bridge, signed)', () => {
  it('a signed publish makes a page (201): pg_ id, its version, the owner link; stored encrypted', async () => {
    const { r } = await world()
    const res = await publish(r, html(1))
    expect(res.status).toBe(201)
    const out = (await res.json()) as { page_id: string; version: string; unchanged: boolean; owner_url: string }
    expect(out.page_id).toMatch(/^pg_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(out.version).toBe(await sha(html(1)))
    expect(out.unchanged).toBe(false)
    expect(out.owner_url).toBe(`${ORIGIN}/p/${out.page_id}`)
    const dir = join(r.dir, 'pages', out.page_id)
    const files = readdirSync(dir)
    expect(files).toEqual([`${out.version}.bin`])
    expect(readFileSync(join(dir, files[0] as string)).includes(Buffer.from('version 1'))).toBe(false)
  })
  it('unsigned, or signed by another key, is refused (401) and stores nothing', async () => {
    const { r } = await world()
    const plain = await fetch(`${r.httpBase}/bridge/pages?thread_id=${THREAD}&title=x`, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: html(1),
    })
    expect(plain.status).toBe(401)
    const forged = await bridgeFetch(
      { httpBase: r.httpBase, bridgeKey: await generateBridgeKey() },
      'POST',
      `/bridge/pages?thread_id=${THREAD}&title=x`,
      html(1),
    )
    expect(forged.status).toBe(401)
    expect(pageRows(r)).toBe(0)
  })
  it('the same bytes twice are one version (200, unchanged)', async () => {
    const { r } = await world()
    const first = (await (await publish(r, html(1))).json()) as { page_id: string }
    const again = await publish(r, html(1), { page_id: first.page_id })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { unchanged: boolean }).unchanged).toBe(true)
    expect(versionRows(r, first.page_id)).toHaveLength(1)
  })
  it('the 11th version drops the oldest; the current one is never dropped', async () => {
    const { r } = await world()
    const { page_id } = (await (await publish(r, html(0))).json()) as { page_id: string }
    for (let i = 1; i <= PAGE_LIMITS.versionsPerPage; i++)
      expect((await publish(r, html(i), { page_id })).status).toBe(201)
    const kept = versionRows(r, page_id).map((v) => v.hash)
    expect(kept).toHaveLength(PAGE_LIMITS.versionsPerPage)
    expect(kept).not.toContain(await sha(html(0)))
    expect(kept.at(-1)).toBe(await sha(html(PAGE_LIMITS.versionsPerPage)))
    expect(readdirSync(join(r.dir, 'pages', page_id))).toHaveLength(PAGE_LIMITS.versionsPerPage)
  })
  it('a page_id this thread did not publish, or that does not exist, is not_found (404), identical either way', async () => {
    const { r } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    const other = await publish(r, html(2), { page_id, thread_id: 'work' })
    const missing = await publish(r, html(2), { page_id: `pg_${newUlid()}` })
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await other.text()).toBe(await missing.text())
    expect(versionRows(r, page_id)).toHaveLength(1)
  })
  it('bad query, non-UTF-8 or empty HTML (400), a version over 10 MiB (413)', async () => {
    const { r } = await world()
    expect((await publish(r, html(1), { thread_id: 'Not A Thread' })).status).toBe(400)
    expect((await publish(r, html(1), { title: 'two\nlines' })).status).toBe(400)
    expect((await publish(r, html(1), { title: 'x'.repeat(PAGE_LIMITS.titleChars + 1) })).status).toBe(400)
    const bad = await publish(r, Uint8Array.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('bad_html')
    expect((await publish(r, '')).status).toBe(400)
    const big = new Uint8Array(PAGE_LIMITS.versionBytes + 1).fill(0x61)
    expect((await publish(r, big)).status).toBe(413)
    expect(pageRows(r)).toBe(0)
  })
  it('507 pages_full past the relay-wide bytes cap and past the page count, with its own message', async () => {
    const { r } = await world({ env: { PAGES_MAX_MB: '1', PAGES_MAX: '2' } })
    const half = 'a'.repeat(600 * 1024)
    expect((await publish(r, `${half}1`)).status).toBe(201)
    const full = await publish(r, `${half}2`)
    expect(full.status).toBe(507)
    expect(await full.json()).toEqual(PAGES_FULL)
    expect((await publish(r, html(1))).status).toBe(201)
    const count = await publish(r, html(2))
    expect(count.status).toBe(507)
    expect(await count.json()).toEqual(PAGES_FULL)
    expect(pageRows(r)).toBe(2)
  })
})

describe('the frame (the owner’s devices only in phase 1)', () => {
  it('serves the current version under exactly the page policy, private and never cached', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    await publish(r, html(2), { page_id })
    const res = await get(r, `/p/${page_id}/frame`, owner(dev))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(PAGE_CSP)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await res.text()).toBe(html(2))
    // a kept older version, by its hash
    const old = await get(r, `/p/${page_id}/frame?v=${await sha(html(1))}`, owner(dev))
    expect(old.status).toBe(200)
    expect(old.headers.get('content-security-policy')).toBe(PAGE_CSP)
    expect(await old.text()).toBe(html(1))
  })
  it('anyone without the owner’s session gets 401; the link and the frame alike', async () => {
    const { r } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    expect((await get(r, `/p/${page_id}/frame`)).status).toBe(401)
    expect((await get(r, `/p/${page_id}`)).status).toBe(401)
  })
  it('missing, malformed, a hash it does not keep: identical 404s', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    const answers = await Promise.all(
      [
        `/p/pg_${newUlid()}/frame`,
        '/p/nope/frame',
        `/p/${page_id}/frame?v=${'0'.repeat(64)}`,
        `/p/${page_id}/frame?v=x`,
      ].map(async (p) => {
        const res = await get(r, p, owner(dev))
        return [res.status, await res.text(), res.headers.get('cache-control')]
      }),
    )
    for (const a of answers) expect(a).toEqual(answers[0])
    expect(answers[0]?.[0]).toBe(404)
  })
  it('the link is a small wrapper under the app policy that frames the page (its frame-src stops self-navigation)', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1), { title: 'Rota <&> "x"' })).json()) as { page_id: string }
    const res = await get(r, `/p/${page_id}`, owner(dev))
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toBe(appCsp(ORIGIN))
    expect(csp).toContain("frame-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.text()
    expect(body).toContain(
      `<iframe src="/p/${page_id}/frame" sandbox="${PAGE_SANDBOX_ATTR}" referrerpolicy="no-referrer"`,
    )
    expect(body).toContain('<title>Rota &lt;&amp;&gt; &quot;x&quot;</title>')
    expect(body).not.toContain('<script')
    expect(body).not.toContain('version 1') // the page's bytes are never in the wrapper
  })
  it('the frame is never served as a top-level page (Sec-Fetch-Dest: document), only inside a frame', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    expect((await get(r, `/p/${page_id}/frame`, { ...owner(dev), 'Sec-Fetch-Dest': 'document' })).status).toBe(404)
    expect((await get(r, `/p/${page_id}/frame`, { ...owner(dev), 'Sec-Fetch-Dest': 'iframe' })).status).toBe(200)
  })
})

describe('the owner’s list and changes (device-signed)', () => {
  it('lists every page with its versions, its share and how full the store is', async () => {
    const { r, dev } = await world()
    const a = (await (await publish(r, html(1), { title: 'A' })).json()) as { page_id: string }
    // a new version carries its title too: the page is named as last published
    await publish(r, html(2), { page_id: a.page_id, title: 'A' })
    const list = (await (await get(r, '/api/pages', owner(dev))).json()) as PageListT
    expect(list.pages).toHaveLength(1)
    expect(list.pages[0]?.versions.map((v) => v.hash)).toEqual([await sha(html(2)), await sha(html(1))])
    expect(list.pages[0]?.current).toBe(await sha(html(2)))
    expect(list.pages[0]?.share).toBeNull()
    expect(list.used_bytes).toBe(html(1).length + html(2).length)
    expect(list.max_pages).toBe(PAGE_LIMITS.pages)
    const one = (await (await get(r, `/api/pages/${a.page_id}`, owner(dev))).json()) as PageInfoT
    expect(one.title).toBe('A')
  })
  it('?thread= lists one thread’s pages only; a malformed thread is 400', async () => {
    const { r, dev } = await world()
    await publish(r, html(1), { title: 'Trip' })
    await publish(r, html(2), { title: 'Work', thread_id: 'work' })
    const trip = (await (await get(r, `/api/pages?thread=${THREAD}`, owner(dev))).json()) as PageListT
    expect(trip.pages.map((p) => p.title)).toEqual(['Trip'])
    const all = (await (await get(r, '/api/pages', owner(dev))).json()) as PageListT
    expect(all.pages.map((p) => p.title)).toEqual(['Work', 'Trip'])
    expect((await get(r, '/api/pages?thread=Not%20A%20Thread', owner(dev))).status).toBe(400)
  })
  it('share: stored, 30 days by default; again with a later end extends it; null is until unshared; unshare ends it', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    const now = r.relay.services.clock.now()
    const shared = (await (
      await act(r, dev, page_id, 'page.share', { scope: 'people', emails: ['ann@example.com'] })
    ).json()) as PageInfoT
    expect(shared.share?.scope).toBe('people')
    expect(Date.parse(shared.share?.expires_at as string) - now).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000)
    const later = new Date(now + 60 * 86_400_000).toISOString()
    const extended = (await (
      await act(r, dev, page_id, 'page.share', { scope: 'org', emails: [], expires_at: later })
    ).json()) as PageInfoT
    expect(extended.share).toMatchObject({ scope: 'org', expires_at: later })
    const forever = (await (
      await act(r, dev, page_id, 'page.share', { scope: 'org', emails: [], expires_at: null })
    ).json()) as PageInfoT
    expect(forever.share?.expires_at).toBeNull()
    const off = (await (await act(r, dev, page_id, 'page.unshare')).json()) as PageInfoT
    expect(off.share).toBeNull()
  })
  it('a change signed by another key (401), for another device (403), replayed (409) or for another page (400) does nothing', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    const stranger = await createDeviceKey()
    expect((await act(r, dev, page_id, 'page.unshare', {}, stranger)).status).toBe(401)
    const wrong = await signOwnerFrame(
      {
        v: 1,
        type: 'page.unshare',
        device_id: stranger.deviceId,
        page_id,
        ts: new Date().toISOString(),
        nonce: newUlid().toLowerCase(),
      },
      stranger.privateKey,
    )
    expect(
      (
        await fetch(`${r.httpBase}/api/pages/${page_id}/unshare`, {
          method: 'POST',
          headers: owner(dev),
          body: JSON.stringify(wrong),
        })
      ).status,
    ).toBe(403)
    const frame = await signOwnerFrame(
      {
        v: 1,
        type: 'page.share',
        device_id: dev.deviceId,
        page_id,
        ts: new Date().toISOString(),
        nonce: newUlid().toLowerCase(),
        scope: 'org',
        emails: [],
      },
      dev.privateKey,
    )
    const send = () =>
      fetch(`${r.httpBase}/api/pages/${page_id}/share`, {
        method: 'POST',
        headers: owner(dev),
        body: JSON.stringify(frame),
      })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(409)
    // a frame for one page posted at another page's path
    const { page_id: other } = (await (await publish(r, html(2))).json()) as { page_id: string }
    expect(
      (
        await fetch(`${r.httpBase}/api/pages/${other}/unshare`, {
          method: 'POST',
          headers: owner(dev),
          body: JSON.stringify(
            await signOwnerFrame({ ...wrong, device_id: dev.deviceId, nonce: newUlid().toLowerCase() }, dev.privateKey),
          ),
        })
      ).status,
    ).toBe(400)
  })
  it('current restores a kept version; delete removes the page, its versions and its files', async () => {
    const { r, dev } = await world()
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    await publish(r, html(2), { page_id })
    const back = (await (await act(r, dev, page_id, 'page.current', { hash: await sha(html(1)) })).json()) as PageInfoT
    expect(back.current).toBe(await sha(html(1)))
    expect(await (await get(r, `/p/${page_id}/frame`, owner(dev))).text()).toBe(html(1))
    expect((await act(r, dev, page_id, 'page.current', { hash: '0'.repeat(64) })).status).toBe(404)
    expect((await act(r, dev, page_id, 'page.delete')).status).toBe(204)
    expect(pageRows(r)).toBe(0)
    expect(versionRows(r, page_id)).toHaveLength(0)
    expect(existsSync(join(r.dir, 'pages', page_id))).toBe(false)
    expect((await get(r, `/p/${page_id}/frame`, owner(dev))).status).toBe(404)
  })
})

describe('the sweeper', () => {
  it('ends a share past its end and keeps the page; an orphan file (no row) goes', async () => {
    const clock = fakeClock('2026-11-11T12:00:00.000Z')
    const { r, dev } = await world({ clock })
    const { page_id } = (await (await publish(r, html(1))).json()) as { page_id: string }
    await act(r, dev, page_id, 'page.share', { scope: 'org', emails: [] })
    const deps = { db: r.relay.services.db, clock, dataDir: r.dir }
    clock.set(clock.now() + 29 * 86_400_000)
    expect(sweepPages(deps)).toEqual({ sharesEnded: 0, orphans: 0 })
    clock.set(clock.now() + 2 * 86_400_000)
    const orphanDir = join(r.dir, 'pages', `pg_${newUlid()}`)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(orphanDir)
    writeFileSync(join(orphanDir, `${'1'.repeat(64)}.bin`), 'x')
    // a stray file beside the page folders goes too, and does not stop the sweep
    writeFileSync(join(r.dir, 'pages', 'stray.tmp'), 'x')
    expect(sweepPages(deps)).toEqual({ sharesEnded: 1, orphans: 2 })
    expect(existsSync(join(r.dir, 'pages', 'stray.tmp'))).toBe(false)
    expect(existsSync(orphanDir)).toBe(false)
    const page = (await (await get(r, `/api/pages/${page_id}`, owner(dev))).json()) as PageInfoT
    expect(page.share).toBeNull()
    expect(page.versions).toHaveLength(1)
  })
})

describe('the page routes with the web app served by the same relay', () => {
  it('never hand /p/* to the web app fallback: an anonymous caller gets 401, not index.html', async () => {
    const web = mkdtempSync(join(tmpdir(), 'talos-web-'))
    writeFileSync(join(web, 'index.html'), '<html>spa</html>')
    relay = await startTestRelay({ webDir: web })
    for (const path of ['/p/pg_01ARZ3NDEKTSV4RRFFQ69G5FAV', '/p/pg_01ARZ3NDEKTSV4RRFFQ69G5FAV/frame', '/p/x']) {
      const res = await fetch(`${relay.httpBase}${path}`)
      expect(res.status, path).toBe(401)
      expect(await res.text(), path).not.toContain('spa')
    }
    // the fallback still serves the app for its own routes
    expect(await (await fetch(`${relay.httpBase}/threads/x`)).text()).toContain('spa')
  })
})
