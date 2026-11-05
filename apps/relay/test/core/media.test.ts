// Media: upload, sniffing, sandbox headers, ranges, sha256 checks, encryption at rest, eviction and rehydrate (spec 5.4).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId, sha256Hex } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInlineMime, sniffMime } from '../../src/core/sniff.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { bridgeFetch, kit, PNG } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const SESSION = { 'X-Test-Session': 'none', Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1' }
const text = (s: string) => new TextEncoder().encode(s)

async function upload(r: TestRelay, bytes: Uint8Array, headers: Record<string, string> = {}) {
  return fetch(`${r.httpBase}/api/media`, {
    method: 'POST',
    body: bytes as BodyInit,
    headers: { ...SESSION, ...headers },
  })
}
const get = (r: TestRelay, path: string, headers: Record<string, string> = {}) =>
  fetch(`${r.httpBase}${path}`, { headers: { ...SESSION, ...headers } })

describe('media upload limits', () => {
  it('MEDIA_DAILY_MAX_MB is the 24-hour byte budget: over it is rate_limited, and the next day is clear', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c, env: { MEDIA_DAILY_MAX_MB: '1' } })
    const big = new Uint8Array(600 * 1024).fill(97)
    expect((await upload(relay, big, { 'content-type': 'text/plain' })).status).toBe(200)
    expect((await upload(relay, big, { 'content-type': 'text/plain' })).status).toBe(429)
    c.advance(25 * 3600_000)
    expect((await upload(relay, big, { 'content-type': 'text/plain' })).status).toBe(200)
  })
})

describe('media', () => {
  it('stores an upload and serves it back with the sandbox headers', async () => {
    relay = await startTestRelay()
    const res = await upload(relay, PNG, {
      'content-type': 'image/png',
      'x-talos-name': 'pixel.png',
      'x-talos-sha256': sha256Hex(PNG),
    })
    expect(res.status).toBe(200)
    const ref = (await res.json()) as {
      media_id: string
      kind: string
      mime: string
      size: number
      sha256: string
      name: string
    }
    expect(ref).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      size: PNG.length,
      sha256: sha256Hex(PNG),
      name: 'pixel.png',
    })
    const got = await get(relay, `/media/${ref.media_id}`)
    expect(got.status).toBe(200)
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG)
    expect(got.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
    )
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(got.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(got.headers.get('accept-ranges')).toBe('bytes')
  })

  it('needs a session', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}/api/media`, { method: 'POST', body: PNG as BodyInit })
    expect(res.status).toBe(401)
    const id = newId('md')
    expect((await fetch(`${relay.httpBase}/media/${id}`)).status).toBe(401)
  })

  it('serves byte ranges with 206 and Content-Range, and 416 for an impossible one', async () => {
    relay = await startTestRelay()
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251)
    // an MP4-looking header so it is stored as video (any type works for ranges)
    bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    const ref = (await (await upload(relay, bytes, { 'content-type': 'video/mp4' })).json()) as { media_id: string }
    const part = await get(relay, `/media/${ref.media_id}`, { range: 'bytes=100-199' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(part.headers.get('content-length')).toBe('100')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200))
    const open = await get(relay, `/media/${ref.media_id}`, { range: 'bytes=990-' })
    expect(open.headers.get('content-range')).toBe('bytes 990-999/1000')
    const suffix = await get(relay, `/media/${ref.media_id}`, { range: 'bytes=-10' })
    expect(suffix.headers.get('content-range')).toBe('bytes 990-999/1000')
    const bad = await get(relay, `/media/${ref.media_id}`, { range: 'bytes=5000-6000' })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe('bytes */1000')
  })

  it('refuses an upload whose sha256 does not match (400) and one that is too large (413)', async () => {
    relay = await startTestRelay({ env: { MEDIA_MAX_MB: '1' } })
    const bad = await upload(relay, PNG, { 'x-talos-sha256': 'f'.repeat(64) })
    expect(bad.status).toBe(400)
    const big = await upload(relay, new Uint8Array(1024 * 1024 + 1), { 'content-type': 'application/octet-stream' })
    expect(big.status).toBe(413)
    const rows = relay.runtime.store.db.prepare('select count(*) n from core_media').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('serves an SVG with a script as a sandboxed attachment', async () => {
    relay = await startTestRelay()
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"><script>document.title=document.cookie</script></svg>')
    const ref = (await (
      await upload(relay, svg, { 'content-type': 'image/svg+xml', 'x-talos-name': 'x.svg' })
    ).json()) as {
      media_id: string
      mime: string
    }
    expect(ref.mime).toBe('image/svg+xml')
    const got = await get(relay, `/media/${ref.media_id}`)
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(got.headers.get('content-security-policy')).toMatch(/^sandbox;/)
  })

  it('sniffs a .html upload that claims image/png as HTML and serves it as an attachment', async () => {
    relay = await startTestRelay()
    const html = text('<!doctype html><html><body><script>fetch("/api/me")</script></body></html>')
    const ref = (await (
      await upload(relay, html, { 'content-type': 'image/png', 'x-talos-name': 'cat.png' })
    ).json()) as { media_id: string; mime: string; kind: string }
    expect(ref.mime).toBe('text/html')
    expect(ref.kind).toBe('html')
    const got = await get(relay, `/media/${ref.media_id}`)
    expect(got.headers.get('content-type')).toContain('text/html')
    expect(got.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(got.headers.get('content-security-policy')).toMatch(/^sandbox;/)
  })

  it('serves HTML attachments only at /media/:id/page, in an opaque-origin sandbox', async () => {
    relay = await startTestRelay()
    const html = text('<!doctype html><title>Report</title><script>1+1</script>')
    const ref = (await (await upload(relay, html, { 'content-type': 'text/html' })).json()) as { media_id: string }
    const page = await get(relay, `/media/${ref.media_id}/page`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:",
    )
    expect(page.headers.get('content-type')).toContain('text/html')
    const png = (await (await upload(relay, PNG, { 'content-type': 'image/png' })).json()) as { media_id: string }
    expect((await get(relay, `/media/${png.media_id}/page`)).status).toBe(404)
  })

  it('cleans the file name and never lets the uploader pick the stored type', async () => {
    relay = await startTestRelay()
    const ref = (await (
      await upload(relay, text('plain words'), {
        'content-type': 'application/pdf',
        'x-talos-name': encodeURIComponent('../../etc/pass"wd\n'),
      })
    ).json()) as { name: string; mime: string }
    expect(ref.name).toBe('passwd')
    expect(ref.mime).toBe('text/plain')
  })

  it('stores the bytes encrypted on the volume', async () => {
    relay = await startTestRelay()
    const secret = text('the meeting is at the old lighthouse, bring the blue folder')
    await upload(relay, secret, { 'content-type': 'text/plain' })
    const dir = join(relay.dir, 'media')
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const raw = readFileSync(join(dir, files[0] as string))
    expect(Buffer.from(raw).includes(Buffer.from('lighthouse'))).toBe(false)
  })

  it('rehydrates evicted media: 410, media.fetch to the bridge, signed PUT, media.ready, then 200 again', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const ref = (await (await upload(relay, PNG, { 'content-type': 'image/png' })).json()) as { media_id: string }
    // age past the buffer window with nobody connected; the hourly sweeper runs on the way
    c.advance(8 * 86_400_000)
    expect((await get(relay, `/media/${ref.media_id}`)).status).toBe(410)
    expect(readdirSync(join(relay.dir, 'media'))).toHaveLength(0)
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge().connect()
    app.send({ type: 'media.fetch', media_id: ref.media_id })
    await bridge.expectFrame('media.fetch', (f) => f.media_id === ref.media_id, { direction: 'in' })
    const put = await bridgeFetch(relay, 'PUT', `/bridge/media/${ref.media_id}`, PNG, {
      'content-type': 'image/png',
      'x-talos-sha256': sha256Hex(PNG),
    })
    expect(put.status).toBe(200)
    await app.expectFrame('media.ready', (f) => f.media_id === ref.media_id)
    expect((await get(relay, `/media/${ref.media_id}`)).status).toBe(200)
  })

  it.each([
    ['talos-v1-status.md', 'text/markdown', '# Status\n\nAll good.\n', 'text/plain'],
    ['notes.txt', 'text/plain', 'hello\n', 'text/plain'],
    ['rows.csv', 'text/csv', 'a,b\n1,2\n', 'text/plain'],
    ['data.json', 'application/json', '{"a":1}', 'application/json'],
    ['doc.pdf', 'application/pdf', '%PDF-1.4\n', 'application/pdf'],
  ])('a bridge upload of %s downloads under that name', async (name, claimed, body, mime) => {
    relay = await startTestRelay()
    const id = newId('md')
    const bytes = text(body)
    const put = await bridgeFetch(relay, 'PUT', `/bridge/media/${id}`, bytes, {
      'content-type': claimed,
      'x-talos-sha256': sha256Hex(bytes),
      'x-talos-name': encodeURIComponent(name),
    })
    expect(put.status).toBe(200)
    const got = await get(relay, `/media/${id}`)
    expect(got.headers.get('content-type')).toBe(mime)
    const cd = got.headers.get('content-disposition') ?? ''
    expect(cd).toContain(`filename="${name}"`)
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`)
    if (!isInlineMime(mime)) expect(cd.startsWith('attachment;')).toBe(true)
  })

  it('media.fetch with no bridge answers mac_offline', async () => {
    relay = await startTestRelay()
    const app = await kit(relay).connectedApp()
    app.send({ type: 'media.fetch', media_id: newId('md') })
    expect((await app.expectFrame('error')).code).toBe('mac_offline')
  })

  it('an unknown id is 404', async () => {
    relay = await startTestRelay()
    expect((await get(relay, `/media/${newId('md')}`)).status).toBe(404)
    expect((await get(relay, '/media/not-an-id')).status).toBe(404)
  })
})

describe('bridge media routes', () => {
  it('PUT stores bytes (sha256 checked), GET returns an owner upload to the bridge; unsigned is 401', async () => {
    relay = await startTestRelay()
    const id = newId('md')
    const unsigned = await fetch(`${relay.httpBase}/bridge/media/${id}`, { method: 'PUT', body: PNG as BodyInit })
    expect(unsigned.status).toBe(401)
    const bad = await bridgeFetch(relay, 'PUT', `/bridge/media/${id}`, PNG, { 'x-talos-sha256': 'e'.repeat(64) })
    expect(bad.status).toBe(400)
    const ok = await bridgeFetch(relay, 'PUT', `/bridge/media/${id}`, PNG, {
      'content-type': 'image/png',
      'x-talos-name': 'agent.png',
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, media_id: id })
    const served = await get(relay, `/media/${id}`)
    expect(served.status).toBe(200)
    const up = (await (await upload(relay, PNG, { 'content-type': 'image/png' })).json()) as { media_id: string }
    const dl = await bridgeFetch(relay, 'GET', `/bridge/media/${up.media_id}`)
    expect(dl.status).toBe(200)
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG)
    expect(dl.headers.get('x-talos-sha256')).toBe(sha256Hex(PNG))
    expect((await bridgeFetch(relay, 'GET', `/bridge/media/${newId('md')}`)).status).toBe(404)
  })
})

describe('sniffMime', () => {
  const cases: Array<[string, Uint8Array, string, string]> = [
    ['png', PNG, '', 'image/png'],
    ['jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), '', 'image/jpeg'],
    ['gif', text('GIF89a....'), '', 'image/gif'],
    ['webp', text('RIFF\0\0\0\0WEBPVP8 '), '', 'image/webp'],
    ['pdf', text('%PDF-1.7\n'), '', 'application/pdf'],
    [
      'webm audio when claimed audio',
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]),
      'audio/webm;codecs=opus',
      'audio/webm',
    ],
    ['webm video otherwise', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), 'video/webm', 'video/webm'],
    ['m4a', text('\0\0\0\x1cftypM4A \0\0'), '', 'audio/mp4'],
    ['mp4', text('\0\0\0\x1cftypisom\0\0'), '', 'video/mp4'],
    ['svg', text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png', 'image/svg+xml'],
    ['html', text('  <!DOCTYPE html><p>x'), 'image/png', 'text/html'],
    ['html fragment', text('<script>alert(1)</script>'), 'image/png', 'text/html'],
    ['json', text('{"a":1}'), 'image/png', 'application/json'],
    ['text', text('just words'), 'application/pdf', 'text/plain'],
    ['binary', Uint8Array.from([0, 1, 2, 3, 250, 251]), 'image/png', 'application/octet-stream'],
  ]
  for (const [name, bytes, claimed, want] of cases) {
    it(name, () => expect(sniffMime(bytes, claimed)).toBe(want))
  }
})
