// An mp3 attachment is played by Safari/WebKit, which asks for byte ranges (first `bytes=0-1`, then open-ended and
// mid-file ranges as it seeks and refills). These run the real relay handler over real HTTP, not a mock.
import { sha256Hex } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: t(20_000) })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const SESSION = { 'X-Test-Session': 'none', Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1' }

/** Bytes that start like an mp3 with an ID3v2 tag, then a run that never repeats a 4-byte window by accident. */
function mp3Like(size: number, start: 'id3' | 'frame'): Uint8Array {
  const b = new Uint8Array(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + (i >> 8) * 17) & 0xff
  b.set(start === 'id3' ? [0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0] : [0xff, 0xfb, 0x90, 0x64])
  return b
}

async function put(r: TestRelay, bytes: Uint8Array, claimed: string) {
  const res = await fetch(`${r.httpBase}/api/media`, {
    method: 'POST',
    body: bytes as BodyInit,
    headers: { ...SESSION, 'content-type': claimed, 'x-talos-name': 'take.mp3', 'x-talos-sha256': sha256Hex(bytes) },
  })
  expect(res.status).toBe(200)
  return (await res.json()) as { media_id: string; mime: string; size: number }
}
const get = (r: TestRelay, id: string, range?: string) =>
  fetch(`${r.httpBase}/media/${id}`, { headers: { ...SESSION, ...(range ? { range } : {}), Connection: 'close' } })

describe('an mp3 served to a player that asks for ranges', () => {
  it.each(['id3', 'frame'] as const)(
    '(%s start) every range answers with the exact bytes, length and type',
    async (start) => {
      relay = await startTestRelay()
      const bytes = mp3Like(400_000, start)
      const ref = await put(relay, bytes, 'audio/mpeg')
      expect(ref.mime).toBe('audio/mpeg')
      const size = bytes.length
      const cases: Array<[string, number, number]> = [
        ['bytes=0-1', 0, 1],
        ['bytes=0-', 0, size - 1],
        ['bytes=196608-', 196_608, size - 1],
        ['bytes=196608-262143', 196_608, 262_143],
        ['bytes=399999-', size - 1, size - 1],
        ['bytes=390000-999999999', 390_000, size - 1],
        ['bytes=-1000', size - 1000, size - 1],
      ]
      for (const [range, from, to] of cases) {
        const res = await get(relay, ref.media_id, range)
        expect(res.status, range).toBe(206)
        expect(res.headers.get('content-type'), range).toBe('audio/mpeg')
        expect(res.headers.get('accept-ranges'), range).toBe('bytes')
        expect(res.headers.get('content-range'), range).toBe(`bytes ${from}-${to}/${size}`)
        expect(res.headers.get('content-length'), range).toBe(String(to - from + 1))
        const got = new Uint8Array(await res.arrayBuffer())
        expect(got.length, range).toBe(to - from + 1)
        expect(sha256Hex(got), range).toBe(sha256Hex(bytes.subarray(from, to + 1)))
      }
    },
  )

  it('a whole-file request is a 200 with the full length and the same bytes', async () => {
    relay = await startTestRelay()
    const bytes = mp3Like(300_001, 'id3')
    const ref = await put(relay, bytes, 'audio/mpeg')
    const res = await get(relay, ref.media_id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(bytes.length))
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(sha256Hex(bytes))
  })

  it('stitching the ranges a player asks for in 64 KiB steps rebuilds the file byte for byte', async () => {
    relay = await startTestRelay()
    const bytes = mp3Like(200_003, 'id3')
    const ref = await put(relay, bytes, 'audio/mpeg')
    const out = new Uint8Array(bytes.length)
    for (let at = 0; at < bytes.length; at += 65_536) {
      const res = await get(relay, ref.media_id, `bytes=${at}-${at + 65_535}`)
      expect(res.status).toBe(206)
      out.set(new Uint8Array(await res.arrayBuffer()), at)
    }
    expect(sha256Hex(out)).toBe(sha256Hex(bytes))
  })
})
