// Takes a picture of the page the owner is looking at, from the page itself: the visible DOM is copied with its computed styles
// into an SVG <foreignObject>, which the browser draws onto a canvas. No library (none is a dependency). Limits, all on purpose:
//  - A picture, video, frame or canvas that came from another origin is NOT drawn (a grey box stands in): drawing it would taint
//    the canvas and make the whole capture fail, and it would also pull another site's pixels into a report.
//  - Fonts are not embedded, so text may look slightly different. Pseudo-elements (::before, ::after) are left out.
//  - It shows the page as it is now, scrolled panes included, but not a native window frame.
// A capture that fails for any reason gives a plain "no screenshot" canvas, so the report can still be written and sent.
import { type Mark, type PictureBlob, render } from './ink.ts'
import { BUG_TEXT } from './text.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MAX_ELEMENTS = 8000
const MAX_PIXELS = 12_000_000
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** A stand-in for something that is not drawn. Theme token, read from the page. */
const PLACEHOLDER_TOKEN = '--surface-2'

/** `ok`: a real picture. `unsupported`: this browser cannot read back a drawn page (WebKit), so none was attempted. */
export type Capture = { canvas: HTMLCanvasElement; ok: boolean; skipped: number; unsupported?: boolean }

/**
 * The longest stretch of copying between pauses, in ms of the page's own clock, so the open sheet keeps answering taps while a
 * big page is copied and the give-up (store.ts, CAPTURE_LIMIT_MS) can land. It was a count, 250 elements; each element copies
 * its whole computed style, so on a slow phone 250 of them held the page for seconds, and a 400-message thread at a tenth of
 * the speed settled after 22 s instead of 8 (2026-11-19). 40 ms, not less: each pause can let the page paint, and at 8 ms a
 * 120-message thread's picture took 7.5 s where it took 5.7 s before (6.3 s at 40 ms), close to the give-up itself.
 */
const SLICE_MS = 40
const pause = () => new Promise<void>((r) => setTimeout(r, 0))

/** Thrown inside a copy whose caller gave up on it (its signal aborted): the copy stops at once instead of running on. */
class CaptureAborted extends Error {}
type CopyCtx = { count: number; skipped: number; token: string; sliceAt: number; signal?: AbortSignal }
/** Pauses when the slice is used up, and stops the copy once it was given up. */
async function slice(ctx: CopyCtx): Promise<void> {
  if (performance.now() - ctx.sliceAt >= SLICE_MS) {
    await pause()
    ctx.sliceAt = performance.now()
  }
  if (ctx.signal?.aborted) throw new CaptureAborted()
}

const sameOrigin = (url: string, base = location.href): boolean => {
  try {
    const u = new URL(url, base)
    if (u.protocol === 'data:' || u.protocol === 'blob:') return true
    return u.origin === location.origin
  } catch {
    return false
  }
}

async function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return url
  if (!sameOrigin(url)) return null
  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.size > 2 * 1024 * 1024) return null
    return await new Promise<string | null>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

function copyStyle(src: Element, dst: HTMLElement | SVGElement) {
  const cs = getComputedStyle(src)
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i)
    dst.style.setProperty(name, cs.getPropertyValue(name), cs.getPropertyPriority(name))
  }
}

function placeholder(src: Element, token: string): HTMLElement {
  const r = src.getBoundingClientRect()
  const d = document.createElement('div')
  d.style.cssText = `display:inline-block;box-sizing:border-box;width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:${token};`
  return d
}

/** Copies `src` and everything below it, styles inlined. Returns null for an element that is dropped. */
async function copyNode(src: Node, ctx: CopyCtx): Promise<Node | null> {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode(false)
  if (!(src instanceof Element)) return null
  if (++ctx.count > MAX_ELEMENTS) return null
  await slice(ctx)
  const tag = src.tagName.toLowerCase()
  if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'noscript' || tag === 'template') return null
  if (src.hasAttribute('data-no-capture')) return null // the Report a bug button itself (BugButton.tsx)
  const cs = getComputedStyle(src)
  if (cs.display === 'none') return null
  if (tag === 'video' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'audio') {
    ctx.skipped++
    return placeholder(src, ctx.token)
  }
  if (tag === 'img') {
    const img = src as HTMLImageElement
    const data = img.currentSrc || img.src ? await toDataUrl(img.currentSrc || img.src) : null
    if (!data) {
      ctx.skipped++
      return placeholder(src, ctx.token)
    }
    const out = document.createElement('img')
    out.setAttribute('src', data)
    copyStyle(src, out)
    return out
  }
  if (tag === 'canvas') {
    let data: string | null = null
    try {
      data = (src as HTMLCanvasElement).toDataURL('image/png')
    } catch {
      data = null
    }
    if (!data) {
      ctx.skipped++
      return placeholder(src, ctx.token)
    }
    const out = document.createElement('img')
    out.setAttribute('src', data)
    copyStyle(src, out)
    return out
  }
  const isSvg = src instanceof SVGElement
  const out = (isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag)) as HTMLElement
  for (const a of Array.from(src.attributes)) {
    if (a.name === 'class' || a.name === 'style' || a.name.startsWith('on')) continue
    if (a.name === 'href' || a.name === 'src' || a.name === 'srcset') continue
    try {
      out.setAttribute(a.name, a.value)
    } catch {
      // an attribute name the serializer would refuse is not needed for the picture
    }
  }
  copyStyle(src, out)
  // a background picture must be inlined (an SVG image loads nothing from the network), or left out if it is from elsewhere
  const bg = cs.backgroundImage
  if (bg && bg !== 'none' && bg.includes('url(')) {
    const m = /url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/.exec(bg)
    const url = m?.[1] ?? m?.[2] ?? m?.[3] ?? ''
    const data = url ? await toDataUrl(url) : null
    if (data && !bg.includes('),')) out.style.setProperty('background-image', `url("${data}")`)
    else {
      out.style.setProperty('background-image', 'none')
      if (!data) ctx.skipped++
    }
  }
  if (tag === 'input') {
    const el = src as HTMLInputElement
    if (el.type === 'password') out.setAttribute('value', '')
    else out.setAttribute('value', el.value)
  }
  if (tag === 'textarea') out.textContent = (src as HTMLTextAreaElement).value
  if (tag === 'select') {
    const sel = src as HTMLSelectElement
    out.textContent = sel.selectedOptions[0]?.textContent ?? ''
  }
  if (tag !== 'textarea' && tag !== 'select') {
    const scrolled = src.scrollTop > 0 || src.scrollLeft > 0
    const holder = scrolled ? document.createElement('div') : out
    if (scrolled) {
      // a scrolled pane: show the part that was on screen by moving its content, since the copy cannot scroll
      holder.style.cssText = `transform:translate(${-src.scrollLeft}px,${-src.scrollTop}px);width:${src.scrollWidth}px;`
      out.style.setProperty('overflow', 'hidden')
      out.appendChild(holder)
    }
    for (const child of Array.from(src.childNodes)) {
      const c = await copyNode(child, ctx)
      if (c) holder.appendChild(c)
    }
  }
  return out
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('picture did not load'))
    img.src = url
  })
}

/** A plain canvas that says there is no picture, so annotating and sending still work. */
export function blankCapture(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const s = getComputedStyle(document.documentElement)
    ctx.fillStyle = s.getPropertyValue('--surface-2').trim() || 'Canvas'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = s.getPropertyValue('--text').trim() || 'CanvasText'
    ctx.font = '16px system-ui, sans-serif'
    ctx.fillText(BUG_TEXT.noPicture, 16, 32)
  }
  return canvas
}

let readBack: Promise<boolean> | null = null
/** The probe's answer once it has one, else null (not asked yet, or still asking). */
let readBackAnswer: boolean | null = null
/** What canReadBackPage found, if it has finished: lets Report a bug open straight into its no-picture layout (store.ts). */
export function readBackKnown(): boolean | null {
  return readBackAnswer
}
let warmed = false
/**
 * Asks canReadBackPage once, when the page is idle, before anyone opens Report a bug: on an iPhone the sheet then opens already
 * saying it takes no picture, instead of drawing "Getting the screen…" and swapping in that sentence a moment later, which
 * moved Preview and the rest down 52 px under a finger already on its way (Titan, 2026-11-19). Called by BugReporter, mounted with the shell.
 */
export function warmReadBack(): void {
  if (warmed || typeof window === 'undefined') return
  warmed = true
  const idle = (window as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback
  const ask = () => void canReadBackPage()
  if (idle) idle(ask, { timeout: 3000 })
  else setTimeout(ask, 1500)
}
/**
 * Can this browser read back a page drawn through an SVG <foreignObject>? WebKit (Safari, the iPhone app, the Mac app) marks
 * such a canvas unreadable, so a capture there is seconds of copying for nothing. Tried once on a tiny page, then remembered.
 */
export function canReadBackPage(): Promise<boolean> {
  readBack ??= (async () => {
    try {
      const svg = `<svg xmlns="${SVG_NS}" width="2" height="2"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:2px;height:2px;background:#000"></div></foreignObject></svg>`
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      const c = document.createElement('canvas')
      c.width = 2
      c.height = 2
      const c2d = c.getContext('2d')
      if (!c2d) {
        readBackAnswer = false
        return false
      }
      c2d.drawImage(img, 0, 0)
      c2d.getImageData(0, 0, 1, 1)
      readBackAnswer = true
      return true
    } catch {
      readBackAnswer = false
      return false
    }
  })()
  return readBack
}

/** A picture the owner chose (photo library, a file, or pasted), scaled to the capture's pixel limit. */
export async function pictureFromFile(file: Blob): Promise<Capture | null> {
  if (!file.type.startsWith('image/')) return null
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) return null
    const f = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * f))
    canvas.height = Math.max(1, Math.round(h * f))
    const c2d = canvas.getContext('2d')
    if (!c2d) return null
    c2d.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { canvas, ok: true, skipped: 0 }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Captures what is on screen now. `root` defaults to the whole page. Never throws: a failure gives a blank canvas and `ok: false`. */
export async function capturePage(root: HTMLElement = document.body, signal?: AbortSignal): Promise<Capture> {
  const width = Math.max(1, Math.round(window.innerWidth))
  const height = Math.max(1, Math.round(window.innerHeight))
  if (!(await canReadBackPage()))
    return { canvas: blankCapture(width, height), ok: false, skipped: 0, unsupported: true }
  // `signal`: the caller gave up (store.ts, after CAPTURE_LIMIT_MS). The copy stops at its next slice, and the steps that cannot
  // be paused (writing the copy out, drawing it) are not started after that.
  const given = () => {
    if (signal?.aborted) throw new CaptureAborted()
  }
  try {
    const rootStyle = getComputedStyle(document.documentElement)
    const token = rootStyle.getPropertyValue(PLACEHOLDER_TOKEN).trim() || 'gray'
    const ctx: CopyCtx = { count: 0, skipped: 0, token, sliceAt: performance.now(), signal }
    const copy = await copyNode(root, ctx)
    given()
    if (!(copy instanceof HTMLElement)) throw new Error('nothing to draw')
    const pos = root.getBoundingClientRect()
    copy.style.setProperty('position', 'absolute')
    copy.style.setProperty('left', `${pos.left}px`)
    copy.style.setProperty('top', `${pos.top}px`)
    copy.style.setProperty('margin', '0')
    copy.style.setProperty('width', `${pos.width}px`)
    copy.style.setProperty('height', `${pos.height}px`)
    const wrap = document.createElement('div')
    wrap.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;background:${rootStyle.getPropertyValue('--bg').trim() || 'white'};`
    wrap.appendChild(copy)
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    const xml = new XMLSerializer().serializeToString(wrap)
    const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`
    await pause() // the give-up may land between writing the copy out and drawing it
    given()
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    given()
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PIXELS / (width * height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * ratio))
    canvas.height = Math.max(1, Math.round(height * ratio))
    const c2d = canvas.getContext('2d')
    if (!c2d) throw new Error('no canvas')
    c2d.drawImage(img, 0, 0, canvas.width, canvas.height)
    c2d.getImageData(0, 0, 1, 1) // throws if the browser tainted the canvas: then there is no usable picture
    return { canvas, ok: true, skipped: ctx.skipped }
  } catch {
    return { canvas: blankCapture(width, height), ok: false, skipped: 0 }
  }
}

function toBlob(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', q?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q))
}

/**
 * The picture that will be sent: the capture with every mark burned in (blur pixelated), as a PNG, or a JPEG when the PNG is over
 * 5 MB, scaled down if it still is. `marks` are in the capture's own pixel scale (`scale` converts from screen to picture).
 */
export async function exportPicture(base: HTMLCanvasElement, marks: readonly Mark[], scale = 1): Promise<PictureBlob> {
  let factor = 1
  for (let tries = 0; tries < 6; tries++) {
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(base.width * factor))
    out.height = Math.max(1, Math.round(base.height * factor))
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    render(ctx, base, marks, scale * factor)
    const png = await toBlob(out, 'image/png')
    if (png && png.size <= IMAGE_MAX_BYTES) return { blob: png, type: 'image/png' }
    const jpg = await toBlob(out, 'image/jpeg', 0.85)
    if (jpg && jpg.size <= IMAGE_MAX_BYTES) return { blob: jpg, type: 'image/jpeg' }
    factor *= 0.7
  }
  throw new Error('picture too large')
}
