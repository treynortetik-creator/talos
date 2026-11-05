// Download / Share for an attachment. The bytes are the file the viewer already shows (fetched from /media/:id with the
// page's own sign-in); nothing is uploaded or sent anywhere. Four ways it ends, chosen once by `deliveryMode`:
//  - 'native': the iPhone shell (Capacitor). The page posts {path, name, mime} to the shell, which fetches the file with the
//    web view's cookies and opens the system share sheet. A blob: anchor does nothing in that web view.
//  - 'share': a phone browser or installed PWA. The File is prepared BEFORE the tap, and navigator.share is called inside the
//    click with nothing awaited first (the browser lets share() run only while the tap's user activation is fresh).
//  - 'link': a plain anchor to the relay file with a download name. A desktop browser saves it; the Mac app's web view hands
//    it to its own download handler; the iPhone shell of an older build opens it in its native media viewer.
// No blob: URL is ever created, so there is nothing to revoke and no HTML blob to navigate to.
import { detectShell } from '../../lib/native/detect.ts'
import { coarsePointer, isNativeShell } from '../../lib/native.ts'
import { fetchTimeoutFor, mediaUrl } from './media.ts'

const EXT_BY_MIME: Record<string, string> = {
  'text/html': 'html',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

type Att = { media_id: string; name: string; mime: string; size?: number }

const CONTROL_AND_DIRECTION =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g
const MAX_NAME_BYTES = 200
const encoder = new TextEncoder()

function capBytes(name: string): string {
  if (encoder.encode(name).length <= MAX_NAME_BYTES) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
  const budget = MAX_NAME_BYTES - encoder.encode(ext).length
  let out = ''
  let used = 0
  for (const ch of name.slice(0, name.length - ext.length)) {
    // iterating a string yields whole code points, so a surrogate pair is never split
    const n = encoder.encode(ch).length
    if (used + n > budget) break
    out += ch
    used += n
  }
  return out + ext
}

/**
 * The attachment's own name made safe to hand to the system: no path parts, no control, direction-override or line-separator
 * characters, no leading dot, at most 200 UTF-8 bytes, and the extension its type calls for (a wrong one is replaced, a
 * missing one appended; a type we do not know keeps the name as it is).
 */
export function safeFileName(name: string, mime: string): string {
  let base = name.replace(CONTROL_AND_DIRECTION, '')
  base = base.split(/[\\/]/).pop() ?? ''
  // whitespace and dots are stripped together, so " .." and ". ." cannot leave a ".." or "." behind
  base = base.replace(/^[\s.]+/, '').trim()
  const ext = EXT_BY_MIME[mime.split(';')[0]?.trim().toLowerCase() ?? '']
  if (ext) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(base)
    const have = m?.[1]?.toLowerCase()
    const fine = have === ext || (ext === 'html' && have === 'htm') || (ext === 'jpg' && have === 'jpeg')
    if (!fine) base = `${m ? base.slice(0, base.length - m[0].length) : base}.${ext}`
    if (base === `.${ext}`) base = `file.${ext}`
  }
  base = capBytes(base)
  return base === '' ? 'file' : base
}

// ---- preparing the file ---------------------------------------------------------------------------------------------

export const PREPARE_TIMEOUT_MS = 30_000
/** The whole body download gets the media gate's size-based budget (2 s per MB), never less than the 30 s floor. */
export const prepareTimeoutFor = (size: number | undefined): number =>
  Math.max(PREPARE_TIMEOUT_MS, fetchTimeoutFor(size))

export class DeliveryError extends Error {
  constructor(readonly code: 'expired' | 'timeout' | 'failed') {
    super(code)
  }
}

/** Fetches the attachment from the relay and wraps it in a File of its real type. Throws a DeliveryError; never retries. */
export async function fetchAttachmentFile(
  att: Att,
  opts: { fetchImpl?: (u: string, i?: RequestInit) => Promise<Response>; signal?: AbortSignal } = {},
): Promise<File> {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, prepareTimeoutFor(att.size))
  const onOuter = () => ac.abort()
  opts.signal?.addEventListener('abort', onOuter)
  try {
    const res = await doFetch(`${mediaUrl(att.media_id)}?c=2`, { credentials: 'same-origin', signal: ac.signal })
    if (res.status === 410 || res.status === 404) throw new DeliveryError('expired')
    if (!res.ok) throw new DeliveryError('failed')
    const buf = await res.arrayBuffer()
    return new File([buf], safeFileName(att.name, att.mime), { type: att.mime })
  } catch (e) {
    if (e instanceof DeliveryError) throw e
    throw new DeliveryError(timedOut ? 'timeout' : 'failed')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuter)
  }
}

// ---- the system share sheet from a browser --------------------------------------------------------------------------

/** The browser refused to open the share sheet (no user activation, no file sharing, anything else but the owner cancelling). */
export class ShareRefused extends Error {}

type NavShare = { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[] }) => Promise<void> }

/**
 * Opens the share sheet for an already-prepared file. `share` is called before this function returns, so when it runs inside a
 * click handler the tap's user activation is still there. 'cancelled' is the owner closing the sheet.
 */
export function shareFileNow(
  file: File,
  nav: NavShare = navigator as unknown as NavShare,
): Promise<'shared' | 'cancelled'> {
  let started: Promise<void>
  try {
    if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || !nav.canShare({ files: [file] }))
      return Promise.reject(new ShareRefused('cannot share this file'))
    started = nav.share({ files: [file] })
  } catch {
    return Promise.reject(new ShareRefused('share threw'))
  }
  return started.then(
    () => 'shared' as const,
    (e: unknown) => {
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled' as const
      throw new ShareRefused((e as { name?: string } | null)?.name ?? 'share failed')
    },
  )
}

// ---- the iPhone shell -----------------------------------------------------------------------------------------------

type NativeScope = { webkit?: { messageHandlers?: { talosShareMedia?: { postMessage?: unknown } } } }

function nativeHandler(scope: unknown): ((m: unknown) => void) | null {
  try {
    const h = (scope as NativeScope).webkit?.messageHandlers?.talosShareMedia
    return h && typeof h.postMessage === 'function' ? (m) => (h.postMessage as (m: unknown) => void).call(h, m) : null
  } catch {
    return null
  }
}

/**
 * Asks the iPhone shell to fetch the file and open the share sheet. The message names the file by its relay path, never a URL;
 * the shell checks the path and the sender before it fetches. False when this build of the shell has no such handler.
 */
export function nativeShareMedia(att: Att, scope: unknown = globalThis): boolean {
  const post = nativeHandler(scope)
  if (!post) return false
  post({ path: mediaUrl(att.media_id), name: safeFileName(att.name, att.mime), mime: att.mime })
  return true
}

/** The shell dispatches this window event when its share sheet is up or the fetch failed (an alert was shown). */
export const SHARE_MEDIA_DONE_EVENT = 'talos:share-media-done'

export type DeliveryMode = 'native' | 'share' | 'link'

export function deliveryMode(scope: unknown = globalThis): DeliveryMode {
  if (detectShell(scope) === 'desktop') return 'link'
  if (isNativeShell(scope)) return nativeHandler(scope) ? 'native' : 'link'
  const nav = (scope as { navigator?: NavShare }).navigator
  return coarsePointer(scope) && typeof nav?.canShare === 'function' && typeof nav?.share === 'function'
    ? 'share'
    : 'link'
}
