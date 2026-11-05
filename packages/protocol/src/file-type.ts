// The "real type" of an upload whose own Content-Type had to be hidden (text/plain is a type an HTML form can send, so the
// media route refuses it on the wire; the app sends application/octet-stream and names the real type in a header instead).
// Only plain-text formats and the usual media types are allowed here. HTML and SVG are not: they run script when opened.

export const FILE_TYPE_HEADER = 'x-talos-file-type'

/** Text formats the owner may upload as text. The relay still checks the bytes really are text before it believes one. */
export const TEXT_FILE_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/vtt',
  'application/x-subrip',
  'application/json',
  'application/x-ndjson',
  'text/yaml',
  'application/yaml',
  'text/x-log',
  'text/rtf',
])

const OTHER_FILE_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/zip',
  'application/octet-stream',
])

/** Lowercased type without parameters, or null when the header is absent. */
export function declaredFileType(raw: string | undefined): string | null {
  if (raw === undefined) return null
  return raw.split(';')[0]?.trim().toLowerCase() ?? ''
}

export function fileTypeAllowed(type: string): boolean {
  return (
    TEXT_FILE_TYPES.has(type) ||
    OTHER_FILE_TYPES.has(type) ||
    /^(image\/(png|jpeg|gif|webp|heic)|audio\/[a-z0-9.+-]+|video\/(mp4|webm|quicktime|ogg|x-msvideo))$/.test(type)
  )
}

/**
 * The type to store. Text formats keep the declared type only when the bytes sniffed as plain text or JSON: a binary
 * or HTML body behind a text label keeps what the sniffer says. Everything else is the sniffed type, as always.
 */
export function storedMime(declared: string | null, sniffed: string): string {
  if (declared && TEXT_FILE_TYPES.has(declared) && (sniffed === 'text/plain' || sniffed === 'application/json'))
    return declared
  return sniffed
}

/** What a browser reports for a file name when it reports nothing (.srt and .vtt often come through with an empty type). */
const TYPE_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  yaml: 'text/yaml',
  yml: 'text/yaml',
}

/**
 * The text type an upload is, from the browser's own type or else the file name; null for anything that is not a plain-text
 * format. The app sends such a file as application/octet-stream with this in X-Talos-File-Type.
 */
export function textTypeOfFile(name: string, browserType: string): string | null {
  const t = browserType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (TEXT_FILE_TYPES.has(t)) return t
  if (t !== '' && t !== 'application/octet-stream') return null
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && TYPE_BY_EXT[ext]) || null
}

/** Types an HTML form can send. The relay refuses these as the Content-Type of an upload or dictation, so the app never sends them. */
export const FORM_SENDABLE_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i
