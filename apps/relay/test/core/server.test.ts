// Static web serving, security headers, health, encryption at rest, retention, headless posts, push routes.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { fakeClock, mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { bridgeFetch, kit, PNG, sub } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const SESSION = { 'X-Test-Session': 'none', Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1' }

function webDir() {
  const dir = mkdtempSync(join(tmpdir(), 'talos-web-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><title>Talos</title><script type="module" src="/assets/app.js"></script>',
  )
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch",()=>{})')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Talos"}')
  return dir
}

describe('security headers and static serving', () => {
  it('/ carries every security header and the exact CSP', async () => {
    relay = await startTestRelay({ webDir: webDir() })
    const res = await fetch(`${relay.httpBase}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const h = (k: string) => res.headers.get(k)
    expect(h('content-security-policy')).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "connect-src 'self' wss://relay.example.com",
        "manifest-src 'self'",
        "worker-src 'self'",
        "frame-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    )
    expect(h('strict-transport-security')).toBe('max-age=63072000')
    expect(h('x-content-type-options')).toBe('nosniff')
    expect(h('referrer-policy')).toBe('no-referrer')
    expect(h('permissions-policy')).toBe('microphone=(self), camera=(), geolocation=(), payment=()')
    expect(h('cross-origin-opener-policy')).toBe('same-origin')
    expect(h('cross-origin-resource-policy')).toBe('same-origin')
  })

  it('every response, API and 404 included, carries the non-CSP headers', async () => {
    relay = await startTestRelay({ webDir: webDir() })
    for (const path of ['/healthz', '/api/nope', '/media/nope', '/assets/app.js']) {
      const res = await fetch(`${relay.httpBase}${path}`)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
      expect(res.headers.get('strict-transport-security'), path).toBe('max-age=63072000')
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer')
    }
  })

  it('falls back to index.html for app routes, not for API paths or missing files', async () => {
    relay = await startTestRelay({ webDir: webDir() })
    const deep = await fetch(`${relay.httpBase}/t/general`)
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('<title>Talos</title>')
    expect((await fetch(`${relay.httpBase}/card/c_01JBF3V7Q8K2M4N6P8R0S2T4V6`)).status).toBe(200)
    expect((await fetch(`${relay.httpBase}/api/does-not-exist`)).status).toBe(404)
    expect((await fetch(`${relay.httpBase}/assets/missing.js`)).status).toBe(404)
    const asset = await fetch(`${relay.httpBase}/assets/app.js`)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect((await fetch(`${relay.httpBase}/sw.js`)).headers.get('cache-control')).toBe('no-cache')
    expect((await fetch(`${relay.httpBase}/manifest.webmanifest`)).headers.get('content-type')).toContain(
      'manifest+json',
    )
  })

  it('does not serve files outside the web directory', async () => {
    const dir = webDir()
    writeFileSync(join(dir, '..', 'talos-outside.txt'), 'outside')
    relay = await startTestRelay({ webDir: dir })
    for (const p of ['/..%2ftalos-outside.txt', '/%2e%2e/talos-outside.txt', '/assets/..%2f..%2ftalos-outside.txt']) {
      const res = await fetch(`${relay.httpBase}${p}`)
      expect(await res.text(), p).not.toContain('outside')
    }
  })

  it('/healthz answers {ok, version} with no auth', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) })
    expect(((await (await fetch(`${relay.httpBase}/healthz`)).json()) as { version: string }).version).not.toBe('0.0.0')
  })

  it('without a web directory the API still answers and / is 404', async () => {
    relay = await startTestRelay()
    expect((await fetch(`${relay.httpBase}/`)).status).toBe(404)
    expect((await fetch(`${relay.httpBase}/healthz`)).status).toBe(200)
  })
})

describe('at rest', () => {
  it("the database file does not contain a sent message's plaintext, nor a reply's", async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const mine = 'MARKER-owner-says-open-the-blue-door'
    const theirs = 'MARKER-agent-says-the-door-is-open'
    const sent = await app.sendMessage('general', mine)
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    bridge.reply('general', theirs)
    await app.expectFrame('reply', (f) => f.message.text === theirs)
    const card = bridge.createCard({ thread_id: 'general', title: 'MARKER-card-title', body: 'MARKER-card-body' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    relay.runtime.store.db.pragma('wal_checkpoint(FULL)')
    const files = readdirSync(relay.dir).filter((f) => f.startsWith('relay.sqlite'))
    expect(files).toContain('relay.sqlite')
    for (const f of files) {
      const bytes = readFileSync(join(relay.dir, f))
      expect(bytes.includes('MARKER'), f).toBe(false)
      expect(bytes.includes(Buffer.from(mine)), f).toBe(false)
    }
    // sanity: the plaintext is recoverable through the relay itself
    const late = k.app({ lastSeq: 0 })
    late.lastSeq = 1
    await late.connect()
    const batch = await late.expectFrame('catchup.batch')
    expect(JSON.stringify(batch.frames)).toContain(theirs)
  })
})

describe('retention', () => {
  it('the sweeper removes rows, seen ids and files older than the buffer window, and keeps younger ones', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const old = await app.sendMessage('general', 'old')
    await bridge.expectFrame('message', (f) => f.id === old.id, { direction: 'in' })
    bridge.reply('general', 'old reply')
    await app.expectFrame('reply')
    const up = await fetch(`${relay.httpBase}/api/media`, {
      method: 'POST',
      body: PNG as BodyInit,
      headers: { ...SESSION, 'content-type': 'image/png' },
    })
    expect(up.status).toBe(200)
    await app.close()
    await bridge.close()
    const store = relay.runtime.store
    const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n
    expect(count('select count(*) n from core_events')).toBeGreaterThan(0)
    expect(readdirSync(join(relay.dir, 'media'))).toHaveLength(1)

    c.advance(6 * 86_400_000) // younger than the 7-day buffer: nothing goes
    expect(count('select count(*) n from core_events')).toBeGreaterThan(0)
    expect(readdirSync(join(relay.dir, 'media'))).toHaveLength(1)

    const k2 = kit(relay)
    const b2 = await k2.bridge().connect()
    b2.reply('general', 'fresh') // written on day 6, must survive the sweep on day 8
    await b2.expectFrame('ack', (f) => f.seq !== undefined, { direction: 'in' })
    await b2.close()

    c.advance(2 * 86_400_000 + 3_600_000) // day 8: the first rows are 8 days old
    expect(count("select count(*) n from core_events where type = 'message'")).toBe(0)
    expect(count("select count(*) n from core_events where type = 'reply'")).toBe(1) // the one from day 6
    expect(count(`select count(*) n from core_dedup where created_at < ${c.now() - 8 * 86_400_000}`)).toBe(0)
    expect(readdirSync(join(relay.dir, 'media'))).toHaveLength(0)
    expect(count('select count(*) n from core_media where evicted = 1')).toBe(1)
    expect(store.floor()).toBeGreaterThan(1)
  })
})

describe('headless posts and bridge HTTP', () => {
  const reply = (text: string) => ({
    ...mkFrame('reply'),
    message: {
      id: `m_${newUlid()}`,
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'headless',
      created_at: new Date().toISOString(),
    },
  })

  it('accepts a signed reply once; a repeat of the same frame id is acked with the same seq and not stored twice', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    const frame = reply('headless hello')
    const first = await bridgeFetch(relay, 'POST', '/bridge/post', JSON.stringify(frame), {
      'content-type': 'application/json',
    })
    expect(first.status).toBe(200)
    const a1 = (await first.json()) as { ack: { ref: string; seq: number } }
    await app.expectFrame('reply', (f) => f.message.text === 'headless hello')
    const second = await bridgeFetch(relay, 'POST', '/bridge/post', JSON.stringify(frame), {
      'content-type': 'application/json',
    })
    const a2 = (await second.json()) as { ack: { ref: string; seq: number } }
    expect(a2.ack).toEqual(a1.ack)
    await sleep(60)
    await vi.waitFor(() => expect(app.rec.of('reply', 'in')).toHaveLength(1), { timeout: 10_000 })
  })

  it('runs module handlers registered on the bus for a frame posted over HTTP', async () => {
    relay = await startTestRelay()
    const seen: string[] = []
    relay.relay.services.bus.onBridgeFrame('reply', (f) => void seen.push(f.message.text ?? ''))
    await bridgeFetch(relay, 'POST', '/bridge/post', JSON.stringify(reply('for the handler')), {
      'content-type': 'application/json',
    })
    expect(seen).toEqual(['for the handler'])
  })

  it('a thread.upsert is stored and shows in ready before the first config.sync', async () => {
    relay = await startTestRelay()
    const frame = {
      ...mkFrame('thread.upsert'),
      thread: {
        id: 'research',
        name: 'Research',
        kind: 'agent',
        order: 5,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: new Date().toISOString(),
      },
    }
    const res = await bridgeFetch(relay, 'POST', '/bridge/post', JSON.stringify(frame), {
      'content-type': 'application/json',
    })
    expect(res.status).toBe(200)
    const app = await kit(relay).connectedApp()
    expect(app.rec.of('ready', 'in')[0]?.threads?.map((t) => t.id)).toContain('research')
  })
})

describe('push routes', () => {
  it('subscribe stores a subscription, unsubscribe removes it, bad bodies are 400', async () => {
    relay = await startTestRelay()
    const post = (body: unknown) =>
      fetch(`${relay?.httpBase}/api/push/subscribe`, {
        method: 'POST',
        headers: { ...SESSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await post(sub())).status).toBe(204)
    expect(relay.runtime.store.listSubs()).toHaveLength(1)
    expect((await post({ endpoint: 'javascript:alert(1)', keys: { p256dh: 'a', auth: 'b' } })).status).toBe(400)
    const del = await fetch(`${relay.httpBase}/api/push/subscribe`, {
      method: 'DELETE',
      headers: { ...SESSION, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub().endpoint }),
    })
    expect(del.status).toBe(204)
    expect(relay.runtime.store.listSubs()).toHaveLength(0)
    const noSession = await fetch(`${relay.httpBase}/api/push/subscribe`, { method: 'POST', body: '{}' })
    expect(noSession.status).toBe(401)
  })

  it('the test notification is sent even while an app is visible, and carries a fixed template', async () => {
    relay = await startTestRelay()
    relay.runtime.store.putSub(sub())
    const app = await kit(relay).connectedApp({ visible: true })
    expect(app.connected).toBe(true)
    const res = await fetch(`${relay.httpBase}/api/push/test`, {
      method: 'POST',
      headers: { ...SESSION, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(204)
    expect(relay.transport.sent).toHaveLength(1)
    expect(relay.transport.sent[0]?.payload.talos.v).toBe(1)
  })
})
