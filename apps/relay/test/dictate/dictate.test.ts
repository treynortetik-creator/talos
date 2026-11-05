// POST /api/dictate on the real relay (real auth, real body guards) against a fake OpenAI server.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN } from '../core/harness.ts'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'
import { type FakeOpenAI, startFakeOpenAI } from './fake-openai.ts'

vi.setConfig({ testTimeout: 30_000 })

const MARKER = 'AUDIO-MARKER-9f3c1d7e5a'
const TRANSCRIPT = 'transcript-words-b81e44c0'
/** A WebM header followed by filler: what a browser recorder produces, as far as the relay looks. */
const webm = (size = 2000) => {
  const b = new Uint8Array(size)
  b.set([0x1a, 0x45, 0xdf, 0xa3])
  b.set(new TextEncoder().encode(MARKER), 16)
  return b
}

let openai: FakeOpenAI
let r: RealRelay | null = null
beforeEach(async () => {
  openai = await startFakeOpenAI()
})
afterEach(async () => {
  await r?.stop()
  r = null
  await openai.stop()
})

async function start(env: Record<string, string> = {}, clock?: ReturnType<typeof fakeClock>) {
  r = await startRealRelay({
    env: { OPENAI_API_KEY: 'sk-test-not-real', OPENAI_BASE_URL: openai.baseUrl, ...env },
    ...(clock ? { clock } : {}),
  })
  return { r, owner: await r.owner() }
}

const send = (
  rel: RealRelay,
  cookie: string | null,
  body: Uint8Array | string,
  over: Record<string, string | null> = {},
) => {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'X-Talos-CSRF': '1',
    'content-type': 'audio/webm;codecs=opus',
  }
  if (cookie) headers.Cookie = cookie
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete headers[k]
    else headers[k] = v
  }
  return fetch(`${rel.httpBase}/api/dictate`, { method: 'POST', headers, body: body as BodyInit })
}

describe('dictation route', () => {
  it('sends the audio to OpenAI with the key and model, and answers with the text', async () => {
    openai.behaviour = { kind: 'text', text: TRANSCRIPT }
    const { r, owner } = await start()
    const res = await send(r, owner.cookie, webm())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: TRANSCRIPT })
    expect(openai.seen).toHaveLength(1)
    expect(openai.seen[0]).toMatchObject({ auth: 'Bearer sk-test-not-real', model: 'gpt-transcribe' })
    expect(openai.seen[0]?.file).toMatch(/\.webm$/)
    expect(openai.seen[0]?.contentType).toMatch(/^multipart\/form-data/)
  })

  it('uses TRANSCRIBE_MODEL when set', async () => {
    const { r, owner } = await start({ TRANSCRIBE_MODEL: 'some-other-model' })
    await send(r, owner.cookie, webm())
    expect(openai.seen[0]?.model).toBe('some-other-model')
  })

  it('401 with no session, and OpenAI is not called', async () => {
    const { r } = await start()
    const res = await send(r, null, webm())
    expect(res.status).toBe(401)
    expect(openai.seen).toHaveLength(0)
  })

  it('403 for a session on a device the Mac has not pinned', async () => {
    const { r } = await start()
    const o = await r.owner({ pinned: false, credentialId: 'cred-2' })
    expect((await send(r, o.cookie, webm())).status).toBe(403)
    expect(openai.seen).toHaveLength(0)
  })

  it('refuses a call without the CSRF header or with a form content type', async () => {
    const { r, owner } = await start()
    const noHeader = await send(r, owner.cookie, webm(), { 'X-Talos-CSRF': null })
    expect([noHeader.status, await noHeader.json()]).toEqual([403, { error: 'csrf_header' }])
    const form = await send(r, owner.cookie, 'a=b', { 'content-type': 'application/x-www-form-urlencoded' })
    expect(form.status).toBe(403)
    const origin = await send(r, owner.cookie, webm(), { Origin: 'https://evil.example.com' })
    expect(origin.status).toBe(403)
    expect(openai.seen).toHaveLength(0)
  })

  it('413 over 25 MB (declared and streamed), nothing sent upstream', async () => {
    const { r, owner } = await start()
    const big = webm(25 * 1024 * 1024 + 1)
    const res = await send(r, owner.cookie, big)
    expect(res.status).toBe(413)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'too_large' })
    expect(openai.seen).toHaveLength(0)
  })

  it('accepts a file at the limit', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '100' })
    const res = await send(r, owner.cookie, webm(25 * 1024 * 1024))
    expect(res.status).toBe(200)
  })

  it('415 for a type that is not audio, and for a body that does not look like the type it claims', async () => {
    const { r, owner } = await start()
    const json = await send(r, owner.cookie, '{}', { 'content-type': 'application/json' })
    expect(json.status).toBe(415)
    // A type an HTML form can send never gets as far as the format check.
    expect((await send(r, owner.cookie, 'hello', { 'content-type': 'text/plain' })).status).toBe(403)
    const html = await send(r, owner.cookie, webm(), { 'content-type': 'text/html' })
    expect(html.status).toBe(415)
    const lie = await send(r, owner.cookie, new TextEncoder().encode('<html>not audio at all</html>'), {
      'content-type': 'audio/webm',
    })
    expect(lie.status).toBe(415)
    expect(((await lie.json()) as { error: string }).error).toBe('unsupported_type')
    expect(openai.seen).toHaveLength(0)
  })

  it('400 for an empty body', async () => {
    const { r, owner } = await start()
    expect((await send(r, owner.cookie, new Uint8Array(0))).status).toBe(400)
  })

  it('takes m4a, wav and mp3 by their headers', async () => {
    const { r, owner } = await start()
    const m4a = new Uint8Array(64)
    m4a.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])
    const wav = new Uint8Array(64)
    wav.set(new TextEncoder().encode('RIFF'))
    wav.set(new TextEncoder().encode('WAVE'), 8)
    const mp3 = new Uint8Array(64)
    mp3.set(new TextEncoder().encode('ID3'))
    expect((await send(r, owner.cookie, m4a, { 'content-type': 'audio/mp4' })).status).toBe(200)
    expect((await send(r, owner.cookie, wav, { 'content-type': 'audio/wav' })).status).toBe(200)
    expect((await send(r, owner.cookie, mp3, { 'content-type': 'audio/mpeg' })).status).toBe(200)
    expect(openai.seen.map((s) => s.file.split('.').pop())).toEqual(['m4a', 'wav', 'mp3'])
  })

  it('429 once the hourly limit is used, with OpenAI not called for the refused one', async () => {
    const { r, owner } = await start()
    let last = 200
    let ok = 0
    for (let i = 0; i < 60 && last === 200; i++) {
      last = (await send(r, owner.cookie, webm(100))).status
      if (last === 200) ok++
    }
    expect(last).toBe(429)
    expect(ok).toBeGreaterThan(0)
    expect(openai.seen).toHaveLength(ok)
  })

  it('refuses over the daily cap with daily_cap, and takes audio again a day later', async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' }, clock)
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(200)
    const over = await send(r, owner.cookie, webm(600 * 1024))
    expect(over.status).toBe(429)
    expect(((await over.json()) as { error: string }).error).toBe('daily_cap')
    expect(openai.seen).toHaveLength(1)
    clock.advance(24 * 3600_000 + 1000)
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(200)
  })

  it('the cap reply carries how many bytes are left, as a number, and no prose', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' })
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(200)
    const over = await send(r, owner.cookie, webm(600 * 1024))
    const body = (await over.json()) as Record<string, unknown>
    expect(body.used_up).toBe(false)
    expect(body.left_bytes).toBe(424 * 1024)
    expect(body.message).toBeUndefined()
  })

  it('when nothing is left the reply says used_up with zero bytes left', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' })
    expect((await send(r, owner.cookie, webm(1000 * 1024))).status).toBe(200) // 24 KiB left: no recording fits in that
    const none = (await (await send(r, owner.cookie, webm(600 * 1024))).json()) as Record<string, unknown>
    expect(none.used_up).toBe(true)
    expect(none.left_bytes).toBe(0)
    expect(none.message).toBeUndefined()
  })

  it('a failed upstream call still counts against the daily cap: nothing is given back', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' })
    openai.behaviour = { kind: 'status', status: 500 }
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(502)
    openai.behaviour = { kind: 'text', text: 'ok' }
    const second = await send(r, owner.cookie, webm(600 * 1024))
    expect([second.status, ((await second.json()) as { error: string }).error]).toEqual([429, 'daily_cap'])
    expect(openai.seen).toHaveLength(1)
  })

  it('a timed out call and an unreadable answer count too', async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1', DICTATE_TIMEOUT_S: '30' }, clock)
    openai.behaviour = { kind: 'hang' }
    const arrived = openai.nextRequest()
    const pending = send(r, owner.cookie, webm(600 * 1024))
    await arrived
    clock.advance(30_000)
    expect((await pending).status).toBe(504)
    openai.behaviour = { kind: 'text', text: 'ok' }
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(429)
  })

  it('the daily cap survives a restart of the relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-dictate-keep-'))
    try {
      const first = await start({ DICTATE_DAILY_MAX_MB: '1', DATA_DIR: dir })
      expect((await send(first.r, first.owner.cookie, webm(600 * 1024))).status).toBe(200)
      await r?.stop()
      r = null
      const second = await start({ DICTATE_DAILY_MAX_MB: '1', DATA_DIR: dir })
      const again = await send(second.r, second.owner.cookie, webm(600 * 1024))
      expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([429, 'daily_cap'])
      expect(openai.seen).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses on a declared length that cannot fit before the body is read or looked at', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' })
    expect((await send(r, owner.cookie, webm(600 * 1024))).status).toBe(200)
    // Not audio: if the relay buffered and sniffed it first, this would be 415. The cap comes first.
    const junk = new Uint8Array(600 * 1024).fill(0x41)
    const res = await send(r, owner.cookie, junk)
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([429, 'daily_cap'])
  })

  it('two recordings sent together cannot both fit under the cap', async () => {
    const { r, owner } = await start({ DICTATE_DAILY_MAX_MB: '1' })
    openai.behaviour = { kind: 'held', text: 'ok' }
    const a = send(r, owner.cookie, webm(600 * 1024))
    const b = send(r, owner.cookie, webm(600 * 1024))
    await openai.nextRequest()
    openai.release()
    const statuses = (await Promise.all([a, b])).map((x) => x.status).sort()
    expect(statuses).toEqual([200, 429])
    expect(openai.seen).toHaveLength(1)
  })

  it('OpenAI taking longer than the 15 s upload idle limit is still waited for, up to DICTATE_TIMEOUT_S', async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_TIMEOUT_S: '90' }, clock)
    openai.behaviour = { kind: 'held', text: TRANSCRIPT }
    const arrived = openai.nextRequest()
    const pending = send(r, owner.cookie, webm(100))
    await arrived
    clock.advance(60_000) // well past the 15 s idle guard, short of the 90 s deadline
    openai.release()
    const res = await pending
    expect([res.status, await res.json()]).toEqual([200, { text: TRANSCRIPT }])
  })

  it("a stall in OpenAI's answer body is a 504 timeout, not upstream_refused", async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_TIMEOUT_S: '30' }, clock)
    openai.behaviour = { kind: 'stall_body' }
    const stalled = openai.nextStalled()
    const pending = send(r, owner.cookie, webm(100))
    await stalled
    // Let the relay take the headers and start on the body (event-loop turns, not a clock wait).
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
    clock.advance(30_000)
    const res = await pending
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([504, 'upstream_timeout'])
  })

  it('when the app drops the connection the OpenAI call is cancelled', async () => {
    const { r, owner } = await start()
    openai.behaviour = { kind: 'hang' }
    const arrived = openai.nextRequest()
    const cut = openai.nextCutOff()
    const ctl = new AbortController()
    const pending = fetch(`${r.httpBase}/api/dictate`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-Talos-CSRF': '1', 'content-type': 'audio/webm', Cookie: owner.cookie },
      body: webm(100) as BodyInit,
      signal: ctl.signal,
    }).catch(() => 'aborted')
    await arrived
    ctl.abort()
    expect(await pending).toBe('aborted')
    await cut
    expect(openai.cutOff).toBe(1)
  })

  it('a timeout also cancels the OpenAI call', async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_TIMEOUT_S: '30' }, clock)
    openai.behaviour = { kind: 'hang' }
    const arrived = openai.nextRequest()
    const cut = openai.nextCutOff()
    const pending = send(r, owner.cookie, webm(100))
    await arrived
    clock.advance(30_000)
    expect((await pending).status).toBe(504)
    await cut
  })

  it('takes the headers real recorders write: Safari mp4 and Android m4a, and refuses a phone photo', async () => {
    const { r, owner } = await start()
    const box = (brand: string, compat: string[]) => {
      const names = [brand, ...compat]
      const size = 16 + names.length * 4
      const b = new Uint8Array(size + 32)
      new DataView(b.buffer).setUint32(0, size)
      b.set(new TextEncoder().encode('ftyp'), 4)
      b.set(new TextEncoder().encode(brand), 8) // major brand, then a zero minor version, then the compatible list
      for (const [i, n] of names.slice(1).entries()) b.set(new TextEncoder().encode(n), 16 + i * 4)
      return b
    }
    const safari = box('isom', ['iso2', 'mp41', 'mp42'])
    const android = box('M4A ', ['M4A ', 'mp42', 'isom'])
    const photo = box('heic', ['mif1', 'heic'])
    expect((await send(r, owner.cookie, safari, { 'content-type': 'audio/mp4' })).status).toBe(200)
    expect((await send(r, owner.cookie, android, { 'content-type': 'audio/x-m4a' })).status).toBe(200)
    const refused = await send(r, owner.cookie, photo, { 'content-type': 'audio/mp4' })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([415, 'unsupported_type'])
    expect(openai.seen.map((x) => x.file)).toEqual(['dictation.m4a', 'dictation.m4a'])
  })

  it('502 upstream_refused when OpenAI answers 500, 401 or 429 (the key is never shown)', async () => {
    const { r, owner } = await start()
    for (const status of [500, 401, 429]) {
      openai.behaviour = { kind: 'status', status, body: '{"error":{"message":"bad key sk-test-not-real"}}' }
      const res = await send(r, owner.cookie, webm(100))
      const text = await res.text()
      expect(res.status).toBe(502)
      expect(JSON.parse(text).error).toBe('upstream_refused')
      expect(text).not.toContain('sk-test-not-real')
    }
  })

  it('502 upstream_unreachable when the connection drops', async () => {
    const { r, owner } = await start()
    openai.behaviour = { kind: 'drop' }
    const res = await send(r, owner.cookie, webm(100))
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([502, 'upstream_unreachable'])
  })

  it('502 upstream_unreachable when OpenAI cannot be reached at all', async () => {
    const { r, owner } = await start({ OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' })
    const res = await send(r, owner.cookie, webm(100))
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([502, 'upstream_unreachable'])
  })

  it('504 upstream_timeout when OpenAI never answers, decided by the relay clock', async () => {
    const clock = fakeClock()
    const { r, owner } = await start({ DICTATE_TIMEOUT_S: '30' }, clock)
    openai.behaviour = { kind: 'hang' }
    const arrived = openai.nextRequest()
    const pending = send(r, owner.cookie, webm(100))
    await arrived
    clock.advance(30_000)
    const res = await pending
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([504, 'upstream_timeout'])
  })

  it('503 dictate_disabled without OPENAI_API_KEY, and /api/me says so', async () => {
    r = await startRealRelay({ env: { OPENAI_BASE_URL: openai.baseUrl } })
    const owner = await r.owner()
    const res = await send(r, owner.cookie, webm())
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([503, 'dictate_disabled'])
    const me = await fetch(`${r.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })
    expect(((await me.json()) as { dictate: unknown }).dictate).toEqual({ available: false })
  })

  it('/api/me says dictation is available with a key', async () => {
    const { r, owner } = await start()
    const me = await fetch(`${r.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })
    expect(((await me.json()) as { dictate: { available: boolean } }).dictate.available).toBe(true)
  })

  it('writes no audio and no transcript to the data directory (files or database)', async () => {
    openai.behaviour = { kind: 'text', text: TRANSCRIPT }
    const { r, owner } = await start()
    expect((await send(r, owner.cookie, webm())).status).toBe(200)
    const dir = (r.relay.services.env as { DATA_DIR: string }).DATA_DIR
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
    const files = walk(dir)
    expect(files.length).toBeGreaterThan(0) // the scan did look at the database
    for (const f of files) {
      const text = readFileSync(f).toString('latin1')
      expect(text.includes(MARKER), `${f} holds audio`).toBe(false)
      expect(text.includes(TRANSCRIPT), `${f} holds the transcript`).toBe(false)
    }
    expect(r.runtime.store.uploadedBytesSince(0)).toBe(0)
  })
})
