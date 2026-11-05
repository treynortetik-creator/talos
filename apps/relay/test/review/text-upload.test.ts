// A text file upload (the owner hit "csrf content type" on a transcript, 2026-11-04). Against the REAL auth and routes:
// text/plain stays refused on the wire (an HTML form can send it), while the app's octet-stream + X-Talos-File-Type works.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterEachReset } from '../auth/helpers.ts'
import { ORIGIN, type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  afterEachReset()
})

const enc = (s: string) => new TextEncoder().encode(s)

async function up(
  rel: RealRelay,
  cookie: string,
  bytes: Uint8Array,
  type: string,
  extra: Record<string, string> = {},
  csrf = true,
) {
  return fetch(`${rel.httpBase}/api/media`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      'content-type': type,
      ...(csrf ? { 'X-Talos-CSRF': '1' } : {}),
      ...extra,
    },
    body: bytes as BodyInit,
  })
}

const TRANSCRIPT = enc('Alex: hello\nBo: hi there\n')

describe('text uploads through /api/media', () => {
  it('a raw text/plain (or form) upload is still refused: the CSRF defence is kept', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    for (const type of [
      'text/plain',
      'text/plain; charset=utf-8',
      'multipart/form-data; boundary=x',
      'application/x-www-form-urlencoded',
    ]) {
      const res = await up(r, o.cookie, TRANSCRIPT, type, { 'x-talos-name': 'a.txt' })
      expect(res.status, type).toBe(403)
      expect(await res.json()).toEqual({ error: 'csrf_content_type' })
    }
    // and a header cannot stand in for the Content-Type: the wire type is still the thing checked
    const sneaky = await up(r, o.cookie, TRANSCRIPT, 'text/plain', { 'x-talos-file-type': 'text/plain' })
    expect(sneaky.status).toBe(403)
  })

  it('octet-stream plus a real text type is accepted and stored with that type and name', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    const cases: Array<[string, string]> = [
      ['text/plain', 'call.txt'],
      ['text/markdown', 'call.md'],
      ['text/csv', 'call.csv'],
      ['text/vtt', 'call.vtt'],
      ['application/x-subrip', 'call.srt'],
    ]
    for (const [type, name] of cases) {
      const res = await up(r, o.cookie, TRANSCRIPT, 'application/octet-stream', {
        'x-talos-file-type': type,
        'x-talos-name': encodeURIComponent(name),
      })
      expect(res.status, type).toBe(200)
      const ref = (await res.json()) as { media_id: string; mime: string; name: string; kind: string }
      expect(ref.mime).toBe(type)
      expect(ref.name).toBe(name)
      expect(ref.kind).toBe('file')
      expect(r.runtime.store.getMediaRow(ref.media_id)?.mime).toBe(type)
    }
    const json = await up(r, o.cookie, enc('{"a":1}'), 'application/octet-stream', {
      'x-talos-file-type': 'application/json',
    })
    expect(((await json.json()) as { mime: string }).mime).toBe('application/json')
  })

  it('a PDF still uploads, and a text label on non-text bytes does not make them text', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    const pdf = await up(r, o.cookie, enc('%PDF-1.4\n%%EOF'), 'application/pdf')
    expect(((await pdf.json()) as { mime: string }).mime).toBe('application/pdf')
    const bin = new Uint8Array([0, 1, 2, 3, 0, 255, 254])
    const lie = await up(r, o.cookie, bin, 'application/octet-stream', { 'x-talos-file-type': 'text/plain' })
    expect(((await lie.json()) as { mime: string }).mime).toBe('application/octet-stream')
    const html = await up(r, o.cookie, enc('<script>alert(1)</script>'), 'application/octet-stream', {
      'x-talos-file-type': 'text/plain',
    })
    expect(((await html.json()) as { mime: string }).mime).toBe('text/html')
  })

  it('a real type outside the allowlist is refused with 415, before anything is stored', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    for (const type of [
      'text/html',
      'image/svg+xml',
      'text/xml',
      'application/xml',
      'application/x-sh',
      'application/javascript',
      '',
    ]) {
      const res = await up(r, o.cookie, TRANSCRIPT, 'application/octet-stream', { 'x-talos-file-type': type })
      expect(res.status, type).toBe(415)
      expect(await res.json()).toEqual({ error: 'file_type_not_allowed' })
    }
  })

  it('still needs the session and the CSRF header', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    const noCsrf = await up(
      r,
      o.cookie,
      TRANSCRIPT,
      'application/octet-stream',
      { 'x-talos-file-type': 'text/plain' },
      false,
    )
    expect(noCsrf.status).toBe(403)
    const noSession = await up(r, 'talos_session=nope', TRANSCRIPT, 'application/octet-stream', {
      'x-talos-file-type': 'text/plain',
    })
    expect(noSession.status).toBe(401)
  })
})
