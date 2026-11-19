// Report a bug opens at once and never waits on the picture (owner, 2026-11-15: on the iPhone it took 2-3 s, so he kept
// tapping). The picture lands when it is ready, unless the sheet closed meanwhile or the owner added his own; taps while it is
// open open nothing more. The iPhone app's own screenshot (a Capacitor plugin) is taken before the sheet, with a short limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capture } from '../../src/features/bugreport/capture.ts'

let pending: Array<(c: Capture) => void> = []
const calls: { capture: number; signal?: AbortSignal } = { capture: 0 }
let known: boolean | null = null
vi.mock('../../src/features/bugreport/capture.ts', () => ({
  capturePage: (_root: unknown, signal?: AbortSignal) => {
    calls.capture++
    calls.signal = signal
    return new Promise<Capture>((r) => pending.push(r))
  },
  blankCapture: () => document.createElement('canvas'),
  pictureFromFile: async () => ({ canvas: document.createElement('canvas'), ok: true, skipped: 0 }),
  readBackKnown: () => known,
}))

import { blobFromDataUrl, CAPTURE_LIMIT_MS, useBugReport } from '../../src/features/bugreport/store.ts'

const pic = (ok = true): Capture => ({ canvas: document.createElement('canvas'), ok, skipped: 0 })
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  pending = []
  calls.capture = 0
  known = null
  useBugReport.getState().close()
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => setTimeout(() => f(0), 0))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Report a bug opens at once', () => {
  it('closing the sheet, or adding a picture, stops the copy at once, not when the give-up comes', async () => {
    void useBugReport.getState().start()
    await flush()
    expect(calls.capture).toBe(1)
    expect(calls.signal?.aborted).toBe(false)
    useBugReport.getState().close()
    expect(calls.signal?.aborted).toBe(true)
    void useBugReport.getState().start()
    await flush()
    expect(calls.capture).toBe(2)
    const second = calls.signal
    expect(second?.aborted).toBe(false)
    useBugReport.getState().setPicture(pic())
    expect(second?.aborted).toBe(true)
    expect(useBugReport.getState()).toMatchObject({ open: true, capturing: false })
  })

  it('where the page is already known not to read back (an iPhone, asked on idle), it opens with no picture at once and copies nothing', async () => {
    known = false
    void useBugReport.getState().start()
    const s = useBugReport.getState()
    expect(s).toMatchObject({ open: true, capturing: false })
    expect(s.capture).toMatchObject({ ok: false, unsupported: true })
    await flush()
    expect(calls.capture).toBe(0)
    expect(useBugReport.getState().capture).toMatchObject({ ok: false, unsupported: true })
  })

  it('the sheet is open before the picture exists; the picture lands after', async () => {
    void useBugReport.getState().start()
    expect(useBugReport.getState()).toMatchObject({ open: true, capture: null, capturing: true })
    await flush()
    expect(calls.capture).toBe(1)
    const shot = pic()
    pending[0]?.(shot)
    await flush()
    expect(useBugReport.getState()).toMatchObject({ open: true, capture: shot, capturing: false })
  })

  it('more taps while it is open take no second picture', async () => {
    const s = useBugReport.getState()
    void s.start()
    void s.start()
    void s.start()
    await flush()
    expect(calls.capture).toBe(1)
  })

  it('a picture the owner added is kept when the capture lands late', async () => {
    void useBugReport.getState().start()
    await flush()
    const mine = pic()
    useBugReport.getState().setPicture(mine)
    pending[0]?.(pic())
    await flush()
    expect(useBugReport.getState().capture).toBe(mine)
  })

  it('a capture that lands after the sheet closed opens nothing and shows nothing', async () => {
    void useBugReport.getState().start()
    await flush()
    useBugReport.getState().close()
    pending[0]?.(pic())
    await flush()
    expect(useBugReport.getState()).toMatchObject({ open: false, capture: null })
  })

  it("the iPhone app's own screenshot is used when it answers, and the page is not copied", async () => {
    const capture = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }))
    vi.stubGlobal('Capacitor', { Plugins: { TalosSnapshot: { capture } } })
    vi.stubGlobal('fetch', () => {
      throw new Error('a fetch of a data: URL is refused by the CSP')
    })
    await useBugReport.getState().start()
    expect(capture).toHaveBeenCalledOnce()
    expect(calls.capture).toBe(0)
    expect(useBugReport.getState()).toMatchObject({ open: true, capturing: false })
    expect(useBugReport.getState().capture?.ok).toBe(true)
  })

  it('a plugin that does not answer in time does not hold the sheet: the page copy takes over', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('Capacitor', { Plugins: { TalosSnapshot: { capture: () => new Promise(() => {}) } } })
      const started = useBugReport.getState().start()
      await vi.advanceTimersByTimeAsync(300)
      expect(useBugReport.getState().open).toBe(false) // still within the plugin's 400 ms
      await vi.advanceTimersByTimeAsync(150)
      expect(useBugReport.getState()).toMatchObject({ open: true, capturing: true })
      await vi.advanceTimersByTimeAsync(50)
      expect(calls.capture).toBe(1)
      pending[0]?.(pic())
      await started
    } finally {
      vi.useRealTimers()
    }
  })

  it('a capture that never finishes is given up, so Send does not wait on it for long', async () => {
    vi.useFakeTimers()
    try {
      void useBugReport.getState().start()
      await vi.advanceTimersByTimeAsync(50)
      expect(useBugReport.getState().capturing).toBe(true)
      await vi.advanceTimersByTimeAsync(CAPTURE_LIMIT_MS)
      expect(useBugReport.getState()).toMatchObject({ open: true, capturing: false })
      expect(useBugReport.getState().capture?.ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("taps while the iPhone app's screenshot is taken do nothing: one screenshot, one sheet", async () => {
    const capture = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }))
    vi.stubGlobal('Capacitor', { Plugins: { TalosSnapshot: { capture } } })
    vi.stubGlobal('fetch', () => {
      throw new Error('a fetch of a data: URL is refused by the CSP')
    })
    const first = useBugReport.getState().start()
    void useBugReport.getState().start()
    void useBugReport.getState().start()
    await first
    expect(capture).toHaveBeenCalledOnce()
    expect(useBugReport.getState().open).toBe(true)
  })

  it('a picture picked after the sheet closed is dropped', () => {
    useBugReport.getState().setPicture(pic())
    expect(useBugReport.getState().capture).toBeNull()
  })

  it("the iPhone app's screenshot is decoded here, never fetched (the CSP refuses a fetch of data:)", async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const b = blobFromDataUrl(png)
    expect(b?.type).toBe('image/png')
    expect(new Uint8Array(await (b as Blob).arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    )
    expect(blobFromDataUrl('data:text/html;base64,PGgxPg==')).toBeNull()
    expect(blobFromDataUrl('https://example.com/x.png')).toBeNull()
  })
})
