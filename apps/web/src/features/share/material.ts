// What a share is on the signed /share page (docs/V2-FEATURES.md V4.3, V4.7). Pure functions, no DOM.
// The shared title, text and URL are DATA: they travel in `share_content` and never enter the message `text`, which is
// only what the owner typed. The bridge wraps the content as untrusted on the way to the agent.
import { type AttachmentRefT, OwnerAttachmentRef, type ShareContentT } from '@talos-app/protocol'

/** Where the manifest `share_target` POSTs. The service worker answers it; the relay only redirects a stray one. */
export const SHARE_TARGET_PATH = '/share-target'
export const SHARE_PAGE_PATH = '/share'
const TEXT_MAX = 32_000
const TITLE_MAX = 300

export type SharedFile = { name: string; type: string; size: number; blob: Blob }
export type SharedMaterial = { title?: string; text?: string; url?: string; files: SharedFile[] }

const clean = (v: string | null | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

/** `?url=&title=&text=` (the bookmarklet, and a GET share target). Anything else in the query is ignored. */
export function materialFromParams(p: URLSearchParams): SharedMaterial {
  const m: SharedMaterial = { files: [] }
  const url = clean(p.get('url'))
  const title = clean(p.get('title'))
  const text = clean(p.get('text'))
  if (url) m.url = url
  if (title) m.title = title
  if (text) m.text = text
  return m
}

const webUrl = (s: string): string | null => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (s.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(s)) return null
  try {
    const u = new URL(s)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

export type Normalized = { content: ShareContentT; notes: string[]; empty: boolean }

/** Makes the material fit the strict, signed `ShareContent`: canonical URL, bounded text, nothing silently lost. */
export function normalizeMaterial(m: SharedMaterial): Normalized {
  const notes: string[] = []
  let text = clean(m.text)
  let url: string | undefined
  if (m.url) {
    const u = webUrl(m.url.trim())
    if (u) url = u
    else text = text ? `${m.url.trim()}\n${text}` : m.url.trim() // not a web link: still the owner's material
  }
  if (!url && text && !/\s/.test(text)) {
    const u = webUrl(text)
    if (u) {
      url = u
      text = undefined
    }
  }
  if (text && text.length > TEXT_MAX) {
    text = text.slice(0, TEXT_MAX)
    notes.push('The shared text was trimmed to 32,000 characters.')
  }
  let title = clean(m.title)
  if (title && title.length > TITLE_MAX) title = title.slice(0, TITLE_MAX)
  const content: ShareContentT = {
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  }
  return { content, notes, empty: Object.keys(content).length === 0 && m.files.length === 0 }
}

/** The strict owner shape of an uploaded attachment (the same fields the socket client signs). */
export function ownerAttachment(a: AttachmentRefT) {
  return OwnerAttachmentRef.parse({
    media_id: a.media_id,
    kind: a.kind,
    role: a.role ?? 'attachment',
    mime: a.mime,
    name: a.name,
    size: a.size,
    sha256: a.sha256,
    ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}),
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
    ...(a.waveform !== undefined ? { waveform: a.waveform } : {}),
  })
}

/** The raw `message` frame the client signs. `text` is the note ONLY; the material rides in `share_content`. */
export function buildShareFrame(a: {
  threadId: string
  note: string
  content: ShareContentT
  attachments: AttachmentRefT[]
  clientMsgId: string
}) {
  return {
    type: 'message' as const,
    thread_id: a.threadId,
    client_msg_id: a.clientMsgId,
    text: a.note,
    attachments: a.attachments.map(ownerAttachment),
    // Always present, even when empty: a files-only share has no note either, and this is the only mark that tells the Mac
    // it was a share (an empty `text` alone also fits a voice note).
    share_content: a.content,
  }
}
