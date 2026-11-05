// What to tell the owner when an attachment upload fails: the real reason when the server or bridge gave one
// (a full disk, a size cap, a rate limit), else a plain "Couldn't upload".
import { TalosClientError } from '../../lib/client.ts'
import { HttpError } from '../../lib/http.ts'
import { getKnownLimits } from '../health/limits.ts'

export const TOO_BIG = 'Too big to send (max 50 MB)'
/** The same note with the relay's real cap when it has told us (Health status), else the old 50 MB wording. */
export const tooBigNote = (): string => {
  const mb = getKnownLimits().uploadMaxMb
  return mb === undefined ? TOO_BIG : `Too big to send (max ${mb} MB)`
}
export const isTooBigNote = (note: string | undefined): boolean => note?.startsWith('Too big to send') === true

const PREFIX = "Couldn't upload"
const say = (reason: string) => `${PREFIX}: ${reason}`

/** The relay's error codes, in words. A code not listed here is never shown as it is. */
const KNOWN: Record<string, string> = {
  too_large: TOO_BIG, // replaced by tooBigNote() below
  rate_limited: say('daily upload limit reached'),
  request_timeout: say('it took too long, try again'),
  bad_request: say('the file was empty or unreadable'),
  unsupported_media_type: say("this file type isn't supported"),
  file_type_not_allowed: say("this file type isn't supported"),
  csrf_content_type: say('the app and the server are out of step, reload the app and try again'),
  csrf_header: say('your sign-in looks out of date, reload the app and try again'),
  csrf_origin: say('your sign-in looks out of date, reload the app and try again'),
  unauthorized: say('you were signed out, sign in again'),
  device_not_pinned: say("this device hasn't been approved on the Mac yet"),
  'sha256 mismatch': say('the file changed on its way up, try again'),
  no_space_left_on_device: say('the Mac is out of disk space'),
}

/** snake_case with no spaces: a machine code, not a sentence for a person. */
const looksLikeCode = (s: string) => /^[a-z0-9]+(?:[_.:-][a-z0-9]+)*$/i.test(s.trim())

/** A reason from the server: a known code in words, a sentence as it is, an unknown code not at all. */
function reasonText(v: string): string | undefined {
  const t = v.trim()
  if (!t) return undefined
  const known = KNOWN[t]
  if (known) return known
  if (looksLikeCode(t)) return undefined
  return say(t.slice(0, 140))
}

function bodyReason(body: unknown): string | undefined {
  if (typeof body === 'string') return reasonText(body)
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  for (const k of ['message', 'reason', 'detail', 'error']) {
    const v = b[k]
    if (typeof v === 'string') {
      const r = reasonText(v)
      if (r) return r
    }
  }
  return undefined
}

/** `undefined` means "no specific reason": the chip falls back to "Couldn't upload". */
export function uploadFailureNote(e: unknown): string | undefined {
  if (e instanceof TalosClientError) {
    if (e.code === 'too_large') return tooBigNote()
    return (e.message && e.message !== e.code ? reasonText(e.message) : undefined) ?? KNOWN[e.code]
  }
  if (e instanceof HttpError) {
    if (e.status === 413) return tooBigNote()
    if (e.status === 415) return KNOWN.unsupported_media_type
    if (e.status === 429) return KNOWN.rate_limited
    const r = bodyReason(e.body)
    if (r) return r
    if (e.status === 507) return say('the Mac is out of disk space')
    if (e.status >= 500) return say(`server error ${e.status}`)
  }
  return undefined
}

/** Folders have no bytes to send; the browser lists them as empty "files". Keep real files only. */
export function droppedFiles(dt: DataTransfer): File[] {
  const out: File[] = []
  const items = Array.from(dt.items ?? [])
  if (items.length > 0 && items.some((i) => i.kind === 'file')) {
    for (const it of items) {
      if (it.kind !== 'file') continue
      const entry = (
        it as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }
      ).webkitGetAsEntry?.()
      if (entry?.isDirectory) continue
      const f = it.getAsFile()
      if (f) out.push(f)
    }
    return out
  }
  return Array.from(dt.files ?? [])
}
