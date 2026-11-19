// Whether the bug reporter is open, and the picture it was opened with. The sheet opens at once (owner, 2026-11-15: on the iPhone
// it took 2-3 s while the page was copied, so he kept tapping); the picture is taken after, with the sheet and its overlay
// left out (data-no-capture), and given up after CAPTURE_LIMIT_MS so Send never waits on it for long. The iPhone app can hand over its own screenshot instead (`TalosSnapshot`, a
// Capacitor plugin): that one is taken before the sheet opens, since a screenshot of pixels would show the sheet.
import { create } from 'zustand'
import { usePalette } from '../palette/store.ts'
import { blankCapture, type Capture, capturePage, pictureFromFile, readBackKnown } from './capture.ts'

type State = {
  open: boolean
  capture: Capture | null
  /** The picture is still being taken. */
  capturing: boolean
  takenAt: Date | null
  /** What had focus when it opened: Esc puts focus back there. */
  returnTo: HTMLElement | null
  start: () => Promise<void>
  close: () => void
  /** A picture the owner added: it replaces the capture, and a capture still running is dropped. */
  setPicture: (c: Capture) => void
}

/** A capture still running after this is given up: the sheet says there is no picture and Send goes on without one. */
export const CAPTURE_LIMIT_MS = 8000

/** Counts opens and closes: a capture that finishes after its sheet closed, or after a picture was added, is dropped. */
let round = 0
/** The iPhone app's screenshot is being taken: taps meanwhile do nothing. */
let starting = false
/**
 * The copy under way, if any: stopped (its signal, its give-up timer) as soon as nobody waits for it any more, the sheet closed
 * or a picture added, not 8 s later, so a slow phone does not go on copying while the owner draws on a picture they added, and a
 * second open never runs beside the first one's copy.
 */
let running: { stop: AbortController; limit: ReturnType<typeof setTimeout> | undefined } | null = null
const stopRunning = () => {
  if (!running) return
  running.stop.abort()
  clearTimeout(running.limit)
  running = null
}
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

/**
 * The plugin's `data:image/...;base64,` answer as a Blob, decoded here: a fetch() of a data: URL is refused by the app's
 * CSP (connect-src 'self'), which threw the iPhone app's own screenshot away (Delphi's simulator, 2026-11-15). Null for
 * anything that is not a base64 PNG or JPEG.
 */
export function blobFromDataUrl(url: string): Blob | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(url)
  if (!m) return null
  try {
    const bin = atob(m[2] as string)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: m[1] })
  } catch {
    return null
  }
}

type NativeSnapshot = { capture: () => Promise<{ dataUrl?: string }> }
const nativeSnapshot = (): NativeSnapshot | undefined =>
  (window as unknown as { Capacitor?: { Plugins?: { TalosSnapshot?: NativeSnapshot } } }).Capacitor?.Plugins
    ?.TalosSnapshot

/** The iPhone app's own screenshot, if it has the plugin and answers within `ms`; null otherwise. */
async function fromNative(ms: number): Promise<Capture | null> {
  const plugin = nativeSnapshot()
  if (!plugin) return null
  try {
    const shot = await Promise.race([plugin.capture(), new Promise<null>((r) => setTimeout(() => r(null), ms))])
    const blob = shot?.dataUrl ? blobFromDataUrl(shot.dataUrl) : null
    return blob ? await pictureFromFile(blob) : null
  } catch {
    return null
  }
}

export const useBugReport = create<State>((set, get) => ({
  open: false,
  capture: null,
  capturing: false,
  takenAt: null,
  returnTo: null,
  start: async () => {
    if (get().open || starting) return
    starting = true
    const mine = ++round
    const active = typeof document === 'undefined' ? null : document.activeElement
    const returnTo = active instanceof HTMLElement && active !== document.body ? active : null
    // whatever opened the reporter (the palette) is gone from the picture
    usePalette.getState().close()
    let native: Capture | null = null
    try {
      // a screenshot of pixels: the palette must be gone from the screen first
      if (nativeSnapshot()) native = await frames().then(() => fromNative(400))
    } finally {
      starting = false
    }
    if (round !== mine) return
    // a browser already known not to read a drawn page back (an iPhone, warmReadBack): the sheet opens in its final,
    // no-picture layout, and nothing below the picture moves after its first frame
    const unsupported: Capture | null =
      native === null && readBackKnown() === false
        ? { canvas: blankCapture(innerWidth, innerHeight), ok: false, skipped: 0, unsupported: true }
        : null
    const first = native ?? unsupported
    set({ open: true, capture: first, capturing: first === null, takenAt: new Date(), returnTo })
    if (first) return
    await frames() // the sheet is up before any copying starts
    if (round !== mine || !get().capturing) return // closed, or a picture added, in those frames
    // the give-up stops the copy too (capturePage's signal), so a slow phone does not go on copying a picture nobody waits for
    stopRunning()
    const mineRun: NonNullable<typeof running> = { stop: new AbortController(), limit: undefined }
    running = mineRun
    const giveUp = new Promise<Capture>((r) => {
      mineRun.limit = setTimeout(() => {
        mineRun.stop.abort()
        r({ canvas: blankCapture(innerWidth, innerHeight), ok: false, skipped: 0 })
      }, CAPTURE_LIMIT_MS)
    })
    const capture = await Promise.race([capturePage(document.body, mineRun.stop.signal), giveUp])
    clearTimeout(mineRun.limit)
    if (running === mineRun) running = null
    if (round !== mine || !get().capturing) return
    set({ capture, capturing: false })
  },
  close: () => {
    round++
    stopRunning()
    set({ open: false, capture: null, capturing: false, takenAt: null })
  },
  setPicture: (c) => {
    if (!get().open) return // a pick that lands after the sheet closed is dropped
    stopRunning()
    set({ capture: c, capturing: false, takenAt: new Date() })
  },
}))

/** Opens the reporter from anywhere (palette, Help). */
export const openBugReport = (): Promise<void> => useBugReport.getState().start()
