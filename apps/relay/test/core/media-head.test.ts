// D4: the app probes /media/:id and /media/:id/page with HEAD before it shows a file chip or an HTML card. The probe is only
// honest if the real relay answers HEAD the way it answers GET: 200 while it holds the bytes, 410 once the buffer let go.
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 20_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

// The relay answers every HEAD with `Connection: close` and shuts the socket. fetch's connection pool can send the next request
// down that socket before it has seen the close, and under load that read fails with ECONNRESET (reproduced with six runs
// of this file at once). Asking for a fresh connection each time leaves nothing to race.
const SESSION = {
  Connection: 'close',
  'X-Test-Session': 'none',
  Origin: 'https://relay.example.com',
  'X-Talos-CSRF': '1',
}
const text = (s: string) => new TextEncoder().encode(s)
const upload = (r: TestRelay, body: string, mime: string, name: string) =>
  fetch(`${r.httpBase}/api/media`, {
    method: 'POST',
    body: text(body) as BodyInit,
    headers: { ...SESSION, 'content-type': mime, 'x-talos-name': name },
  })
const head = (r: TestRelay, path: string) => fetch(`${r.httpBase}${path}`, { method: 'HEAD', headers: SESSION })

describe('HEAD probes of media', () => {
  it('a file: 200 with no body while the relay has it, 410 after the 7-day buffer, 404 for an unknown id', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const ref = (await (await upload(relay, 'a,b\n1,2\n', 'text/csv', 'rows.csv')).json()) as { media_id: string }
    const fresh = await head(relay, `/media/${ref.media_id}`)
    expect(fresh.status).toBe(200)
    expect((await fresh.arrayBuffer()).byteLength).toBe(0)
    c.advance(8 * 86_400_000)
    expect((await head(relay, `/media/${ref.media_id}`)).status).toBe(410)
    expect((await head(relay, '/media/md_00000000000000000000000000')).status).toBe(404)
  })

  it('an HTML page: 200 while held, 410 after the buffer', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const ref = (await (await upload(relay, '<p>hi</p>', 'text/html', 'r.html')).json()) as { media_id: string }
    expect((await head(relay, `/media/${ref.media_id}/page`)).status).toBe(200)
    c.advance(8 * 86_400_000)
    expect((await head(relay, `/media/${ref.media_id}/page`)).status).toBe(410)
  })

  it('every 410 and 404 says no-store: Chromium would keep a bare 410 forever and the answer flips when the Mac re-sends', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const ref = (await (await upload(relay, '<p>hi</p>', 'text/html', 'r.html')).json()) as { media_id: string }
    c.advance(8 * 86_400_000)
    for (const path of [`/media/${ref.media_id}`, `/media/${ref.media_id}/page`]) {
      for (const method of ['GET', 'HEAD']) {
        const res = await fetch(`${relay.httpBase}${path}`, { method, headers: SESSION })
        expect(res.status, `${method} ${path}`).toBe(410)
        expect(res.headers.get('cache-control'), `${method} ${path}`).toBe('no-store')
      }
    }
    const missing = await head(relay, '/media/md_00000000000000000000000000')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')
  })
})

describe('upload time limits on the real server', () => {
  it("node's own requestTimeout sits above the 10 minute body ceiling, so a slow 50 MB upload is never cut with a bare 400", async () => {
    relay = await startTestRelay({ clock: fakeClock(new Date().toISOString()) })
    expect(relay.relay.http.requestTimeout).toBeGreaterThan(10 * 60_000)
  })
})
