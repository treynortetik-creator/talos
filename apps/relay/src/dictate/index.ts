// Dictation: POST /api/dictate takes one recording, has OpenAI turn it into text, and answers with the text. The audio
// lives in memory for this request only: not in the media store, not on disk, not in the database. Logs carry lengths and
// status, never audio or words. The app puts the text in the message box; nothing here sends a message.
import { Hono } from 'hono'
import { rateLimit, requireCsrf, requireSession } from '../auth/contract.ts'
import { idleBodyTimeout, lateRequest, limitBody } from '../core/body-guard.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { type AudioKind, sniffAudio } from './sniff.ts'

export const routes = new Hono<AppEnv>()

const MIB = 1024 * 1024
const DAY_MS = 24 * 3600_000
/** OpenAI's own limit for one file. */
export const DICTATE_MAX_BYTES = 25 * MIB

const ALLOWED_TYPES = new Set([
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'video/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
])

const MIME_FOR: Record<AudioKind, string> = {
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
}

/**
 * Counts `bytes` against the last 24 hours and says whether they fit. Check and write are one synchronous step, so two
 * recordings arriving together cannot both squeeze under the cap. The rows live in the database: a restart keeps them.
 */
function reserveBytes(services: RelayServices, bytes: number, capMb: number): boolean {
  const now = services.clock.now()
  const db = services.db
  return db.transaction(() => {
    db.prepare('delete from voice_dictation_usage where at <= ?').run(now - DAY_MS)
    const row = db.prepare('select coalesce(sum(bytes), 0) as n from voice_dictation_usage').get() as { n: number }
    if (row.n + bytes > capMb * MIB) return false
    db.prepare('insert into voice_dictation_usage (at, bytes) values (?, ?)').run(now, bytes)
    return true
  })()
}

/** Bytes already counted today, for refusing before a body is buffered. */
function usedBytes(services: RelayServices): number {
  const since = services.clock.now() - DAY_MS
  const row = services.db
    .prepare('select coalesce(sum(bytes), 0) as n from voice_dictation_usage where at > ?')
    .get(since) as { n: number }
  return row.n
}

const fail = (
  c: import('hono').Context<AppEnv>,
  status: 413 | 415 | 429 | 502 | 503 | 504 | 400,
  error: string,
  message: string,
) => c.json({ error, message }, status)

/** Under this much left, no recording of any use fits: the app says the limit is used up, not "try a shorter one". */
const USED_UP_BELOW = 32 * 1024

/** Says how much of the day's allowance is left, as a number; the app words it itself. Zero when under the used-up line. */
const capReply = (c: import('hono').Context<AppEnv>, services: RelayServices, capMb: number) => {
  const left = Math.max(0, capMb * MIB - usedBytes(services))
  const usedUp = left < USED_UP_BELOW
  return c.json({ error: 'daily_cap', used_up: usedUp, left_bytes: usedUp ? 0 : left }, 429)
}

routes.post(
  '/api/dictate',
  limitBody(() => DICTATE_MAX_BYTES),
  // The idle guard covers the upload only. Once the body is in, the wait for OpenAI belongs to DICTATE_TIMEOUT_S (504).
  idleBodyTimeout(undefined, undefined, { stopWhenBodyIn: true }),
  requireSession,
  requireCsrf,
  rateLimit('dictate'),
  async (c) => {
    const services = c.get('services')
    const { OPENAI_API_KEY, OPENAI_BASE_URL, TRANSCRIBE_MODEL, DICTATE_DAILY_MAX_MB, DICTATE_TIMEOUT_S } = services.env
    const log = services.log
    if (!OPENAI_API_KEY || DICTATE_DAILY_MAX_MB === 0)
      return fail(c, 503, 'dictate_disabled', 'Dictation is not set up on this relay.')
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!ALLOWED_TYPES.has(type))
      return fail(c, 415, 'unsupported_type', 'That recording format is not supported. Use m4a, mp4, wav, webm or mp3.')
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > DICTATE_MAX_BYTES) return fail(c, 413, 'too_large', 'That recording is over 25 MB.')
    // A declared length that cannot fit is refused before a byte is buffered.
    if (declared > 0 && usedBytes(services) + declared > DICTATE_DAILY_MAX_MB * MIB) {
      log.warn({ bytes: declared }, 'dictate refused: daily cap')
      return capReply(c, services, DICTATE_DAILY_MAX_MB)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
    if (bytes.length === 0) return fail(c, 400, 'bad_request', 'The recording was empty.')
    if (bytes.length > DICTATE_MAX_BYTES) return fail(c, 413, 'too_large', 'That recording is over 25 MB.')
    const kind = sniffAudio(bytes)
    if (!kind) return fail(c, 415, 'unsupported_type', 'That does not look like a supported recording.')

    // Counted as the call is sent, and never given back: OpenAI may bill a recording it then fails to answer.
    if (!reserveBytes(services, bytes.length, DICTATE_DAILY_MAX_MB)) {
      log.warn({ bytes: bytes.length }, 'dictate refused: daily cap')
      return capReply(c, services, DICTATE_DAILY_MAX_MB)
    }

    const form = new FormData()
    form.append('model', TRANSCRIBE_MODEL)
    form.append('response_format', 'json')
    form.append('file', new Blob([bytes], { type: MIME_FOR[kind] }), `dictation.${kind}`)
    const ctl = new AbortController()
    let timedOut = false
    const timer = services.clock.setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, DICTATE_TIMEOUT_S * 1000)
    // The call stops at the deadline, and also when the app hangs up: nobody is left to read the answer.
    const clientGone = c.req.raw.signal
    try {
      const res = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.any([ctl.signal, clientGone]),
      })
      if (!res.ok) {
        // The reply is dropped unread: it can repeat the key's tail or the owner's words.
        await res.body?.cancel().catch(() => undefined)
        log.warn({ bytes: bytes.length, upstream_status: res.status }, 'dictate: OpenAI refused')
        return fail(
          c,
          502,
          'upstream_refused',
          'The transcription service refused the recording. Try again in a moment.',
        )
      }
      // Reading the body can stall too; an abort here throws to the catch below and counts as a timeout.
      const raw = await res.text()
      let parsed: { text?: unknown } | null = null
      try {
        parsed = JSON.parse(raw) as { text?: unknown } | null
      } catch {
        parsed = null
      }
      if (typeof parsed?.text !== 'string') {
        log.warn({ bytes: bytes.length }, 'dictate: OpenAI answer had no text')
        return fail(c, 502, 'upstream_refused', 'The transcription service gave an answer the relay could not read.')
      }
      log.info({ bytes: bytes.length, text_length: parsed.text.length }, 'dictate ok')
      return c.json({ text: parsed.text })
    } catch {
      if (timedOut) {
        log.warn({ bytes: bytes.length }, 'dictate: OpenAI timed out')
        return fail(c, 504, 'upstream_timeout', 'The transcription service took too long. Try again.')
      }
      if (clientGone.aborted) {
        log.warn({ bytes: bytes.length }, 'dictate: the app left, OpenAI call cancelled')
        return c.json({ error: 'client_left' }, 499 as 400)
      }
      log.warn({ bytes: bytes.length }, 'dictate: OpenAI unreachable')
      return fail(c, 502, 'upstream_unreachable', 'The relay could not reach the transcription service. Try again.')
    } finally {
      services.clock.clearTimeout(timer)
    }
  },
)
