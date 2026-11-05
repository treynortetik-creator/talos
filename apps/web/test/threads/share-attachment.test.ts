import { describe, expect, it, vi } from 'vitest'
import {
  deliveryMode,
  fetchAttachmentFile,
  nativeShareMedia,
  PREPARE_TIMEOUT_MS,
  prepareTimeoutFor,
  ShareRefused,
  safeFileName,
  shareFileNow,
} from '../../src/features/threads/shareAttachment.ts'

const att = { media_id: 'md_01HZX', name: 'notes.pdf', mime: 'application/pdf' }
const bytes = new TextEncoder().encode('%PDF-1.4 hello')
const utf8 = (s: string) => new TextEncoder().encode(s).length

describe('safeFileName', () => {
  it('trims whitespace before stripping leading dots, so " .." cannot come out as ".."', () => {
    for (const n of [' ..', ' .', '. .', ' . . ', '\t..\n', '.. ', '\u00a0..']) {
      const out = safeFileName(n, 'application/pdf')
      expect(out).toBe('file.pdf')
    }
    for (const n of [' ..', ' .', '..', '']) {
      const out = safeFileName(n, 'application/x-unknown')
      expect(out).toBe('file')
    }
    expect(safeFileName('  ..hidden.pdf ', 'application/pdf')).toBe('hidden.pdf')
  })
  it('drops path parts and C0/C1 controls', () => {
    expect(safeFileName('../../etc/passwd.txt', 'text/plain')).toBe('passwd.txt')
    expect(safeFileName('a\\b\\notes.pdf', 'application/pdf')).toBe('notes.pdf')
    expect(safeFileName('re\u0000po\u001frt\u007f\u0085\u009f.pdf', 'application/pdf')).toBe('report.pdf')
  })
  it('strips bidi overrides, isolates and line/paragraph separators', () => {
    expect(safeFileName('inv‮efdp.exe', 'application/pdf')).toBe('invefdp.pdf')
    expect(safeFileName('a⁦b⁧c⁨d⁩e.pdf', 'application/pdf')).toBe('abcde.pdf')
    for (const c of ['‪', '‫', '‬', '‭', '‮', ' ', ' ']) {
      expect(safeFileName(`x${c}y.pdf`, 'application/pdf')).toBe('xy.pdf')
    }
  })
  it('caps the name at 200 UTF-8 bytes, never splits a surrogate pair, keeps the extension', () => {
    const n = safeFileName(`${'\u{1F600}'.repeat(100)}.pdf`, 'application/pdf')
    expect(utf8(n)).toBeLessThanOrEqual(200)
    expect(n.endsWith('.pdf')).toBe(true)
    expect(n).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(utf8(safeFileName(`${'a'.repeat(500)}.pdf`, 'application/pdf'))).toBe(200)
    expect(utf8(safeFileName('é'.repeat(300), 'text/plain'))).toBeLessThanOrEqual(200)
  })
  it('makes the extension match the type: replaces a wrong one, appends a missing one', () => {
    expect(safeFileName('invoice.exe', 'application/pdf')).toBe('invoice.pdf')
    expect(safeFileName('photo.html', 'image/png')).toBe('photo.png')
    expect(safeFileName('scan', 'application/pdf')).toBe('scan.pdf')
    expect(safeFileName('summary', 'text/html')).toBe('summary.html')
    expect(safeFileName('summary.htm', 'text/html')).toBe('summary.htm')
    expect(safeFileName('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg')
    expect(safeFileName('photo.JPG', 'image/jpeg')).toBe('photo.JPG')
    expect(safeFileName('voice', 'audio/mp4; codecs=mp4a')).toBe('voice.m4a')
    expect(safeFileName('report.v2', 'application/pdf')).toBe('report.pdf')
  })
  it('keeps the name as is for a type it does not know, and never returns an empty or hidden name', () => {
    expect(safeFileName('thing.bin', 'application/x-weird')).toBe('thing.bin')
    expect(safeFileName('', 'application/octet-stream')).toBe('file')
    expect(safeFileName('///', 'text/html')).toBe('file.html')
    expect(safeFileName('.hidden', 'text/plain')).toBe('hidden.txt')
    expect(safeFileName('‮ ', 'application/pdf')).toBe('file.pdf')
  })
})

describe('shareFileNow', () => {
  const file = new File([bytes], 'notes.pdf', { type: 'application/pdf' })
  it('calls share in the same turn as the click: nothing is awaited before it', () => {
    const share = vi.fn(async () => {})
    const p = shareFileNow(file, { canShare: () => true, share })
    expect(share).toHaveBeenCalledTimes(1) // before any await in the caller
    return expect(p).resolves.toBe('shared')
  })
  it('a cancelled sheet is "cancelled", not an error', async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'AbortError' })
    })
    await expect(shareFileNow(file, { canShare: () => true, share })).resolves.toBe('cancelled')
  })
  it('a refusal (NotAllowedError, anything else) is a ShareRefused, never "downloaded" or "shared"', async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error('x'), { name: 'NotAllowedError' })
    })
    await expect(shareFileNow(file, { canShare: () => true, share })).rejects.toBeInstanceOf(ShareRefused)
  })
  it('canShare false is refused without calling share', async () => {
    const share = vi.fn(async () => {})
    await expect(shareFileNow(file, { canShare: () => false, share })).rejects.toBeInstanceOf(ShareRefused)
    expect(share).not.toHaveBeenCalled()
  })
  it('a missing share API is refused too', async () => {
    await expect(shareFileNow(file, {})).rejects.toBeInstanceOf(ShareRefused)
  })
})

describe('fetchAttachmentFile', () => {
  const ok = () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  it('builds a File with the attachment type (not the response type) and the safe name', async () => {
    const f = await fetchAttachmentFile({ ...att, name: 'invoice.exe' }, { fetchImpl: async () => ok() })
    expect(f.name).toBe('invoice.pdf')
    expect(f.type).toBe('application/pdf')
    expect(f.size).toBe(bytes.length)
  })
  it('asks the relay with the page sign-in and a signal', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => ok())
    await fetchAttachmentFile(att, { fetchImpl })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/media/md_01HZX?c=2')
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
  it('a 410 or 404 throws "expired" once; it does not retry', async () => {
    for (const status of [410, 404]) {
      const fetchImpl = vi.fn(async () => new Response('gone', { status }))
      await expect(fetchAttachmentFile(att, { fetchImpl })).rejects.toMatchObject({ code: 'expired' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })
  it('other failures say "failed"', async () => {
    await expect(
      fetchAttachmentFile(att, { fetchImpl: async () => new Response('x', { status: 500 }) }),
    ).rejects.toMatchObject({ code: 'failed' })
    await expect(
      fetchAttachmentFile(att, {
        fetchImpl: async () => {
          throw new TypeError('network')
        },
      }),
    ).rejects.toMatchObject({ code: 'failed' })
  })
  it('a 45 MB file gets far more than 30 s; a small or unsized one keeps the 30 s floor', async () => {
    expect(prepareTimeoutFor(undefined)).toBe(30_000)
    expect(prepareTimeoutFor(1024)).toBe(30_000)
    expect(prepareTimeoutFor(45 * 1_048_576)).toBe(20_000 + 2_000 * 45)
    vi.useFakeTimers()
    try {
      let aborted = false
      const fetchImpl = (_u: string, i?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          i?.signal?.addEventListener('abort', () => {
            aborted = true
            rej(new DOMException('aborted', 'AbortError'))
          })
        })
      const p = fetchAttachmentFile({ ...att, size: 45 * 1_048_576 }, { fetchImpl })
      const seen = expect(p).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS + 1)
      expect(aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(prepareTimeoutFor(45 * 1_048_576))
      expect(aborted).toBe(true)
      await seen
    } finally {
      vi.useRealTimers()
    }
  })
  it('gives up after 30 s when the relay never answers', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (_u: string, i?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          i?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        })
      const p = fetchAttachmentFile(att, { fetchImpl })
      const seen = expect(p).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(PREPARE_TIMEOUT_MS + 1)
      await seen
    } finally {
      vi.useRealTimers()
    }
    expect(PREPARE_TIMEOUT_MS).toBe(30_000)
  })
})

describe('deliveryMode and the native share message', () => {
  const posted: unknown[] = []
  const shell = (extra: Record<string, unknown> = {}) => {
    const w: Record<string, unknown> = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
      webkit: { messageHandlers: { talosShareMedia: { postMessage: (m: unknown) => posted.push(m) } } },
      ...extra,
    }
    w.top = w
    return w
  }
  it('Capacitor with the handler is native; the message carries only path, name and type', () => {
    posted.length = 0
    const w = shell()
    expect(deliveryMode(w)).toBe('native')
    expect(nativeShareMedia({ ...att, name: 'in‮voice.exe', size: 5 } as never, w)).toBe(true)
    expect(posted).toEqual([{ path: '/media/md_01HZX', name: 'invoice.pdf', mime: 'application/pdf' }])
  })
  it('Capacitor of an older build (no handler) falls back to the link, which opens the native viewer', () => {
    const w = shell({ webkit: undefined })
    expect(deliveryMode(w)).toBe('link')
    expect(nativeShareMedia(att, w)).toBe(false)
  })
  it('a phone browser that can share files is "share"; one that cannot, or a desktop, is "link"', () => {
    const phone = (canShare: unknown) => {
      const w: Record<string, unknown> = {
        matchMedia: () => ({ matches: true }),
        navigator: { canShare, share: () => {} },
      }
      w.top = w
      return w
    }
    expect(deliveryMode(phone(() => true))).toBe('share')
    expect(deliveryMode(phone(undefined))).toBe('link')
    expect(deliveryMode({ matchMedia: () => ({ matches: false }), navigator: { canShare: () => true } })).toBe('link')
  })
  it('the Mac app is a link (its web view saves through the download handler)', () => {
    const w: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage: () => {} } } },
      navigator: { userAgent: 'x TalosDesktop/1', canShare: () => true },
      matchMedia: () => ({ matches: true }),
    }
    w.top = w
    expect(deliveryMode(w)).toBe('link')
  })
  it('a look-alike frame is not a shell', () => {
    const w = shell()
    w.top = {}
    expect(deliveryMode(w)).toBe('link')
  })
})
