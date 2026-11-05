// The pure part of Settings -> Health (docs/V2-FEATURES.md V2.5): GET /api/status in, rows / notes / banner out. Times are
// read against the status' own `at`, never the browser's clock, so a row never disagrees with the server that wrote it.
// (The V2.5 "External check" row is dropped: the hourly external check is not built, owner 2026-10-29.)
import { DISK_LOW_BYTES, DISK_RECOVERED_BYTES, type HealthStatusT } from '@talos-app/protocol'
import { clockTime, relativeTime } from '../../lib/format.ts'

export type Tone = 'ok' | 'warn' | 'bad' | 'idle'
export type HealthRow = {
  id: 'relay' | 'bridge' | 'mod' | 'disk' | 'scheduler' | 'alerts'
  label: string
  tone: Tone
  detail: string
}

/** The Mac counts as "really gone" in red after this long. */
export const RED_AFTER_MS = 12 * 3600_000

const agoAt = (iso: string | null, nowMs: number) => {
  const r = relativeTime(iso, nowMs)
  return r === 'now' || r === '' ? 'just now' : `${r} ago`
}

/** "12.4 GB" / "850 MB": whole numbers under 1 GB, one decimal above. Never rounds a low disk up into a comfortable one. */
export function formatFree(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${(Math.floor(gb * 10) / 10).toFixed(1)} GB`
  return `${Math.floor(bytes / 1024 ** 2)} MB`
}

export function healthRows(s: HealthStatusT, extra: { scheduler: { state: string | null } | undefined }): HealthRow[] {
  const now = Date.parse(s.at)
  const rows: HealthRow[] = []

  // Relay
  const full = s.relay_problems.includes('storage_full')
  rows.push({
    id: 'relay',
    label: 'Relay',
    tone: full ? 'bad' : 'ok',
    detail: `${full ? 'Relay storage is nearly full · ' : ''}up since ${clockTime(s.relay.up_since)} · v${s.relay.version}`,
  })

  // Mac bridge
  if (s.bridge.online) {
    rows.push({ id: 'bridge', label: 'Mac bridge', tone: 'ok', detail: 'connected · seen just now' })
  } else {
    const since = s.bridge.down_since ?? s.bridge.last_seen
    const red = since !== null && now - Date.parse(since) > RED_AFTER_MS
    rows.push({
      id: 'bridge',
      label: 'Mac bridge',
      tone: red ? 'bad' : 'warn',
      detail: since ? `offline since ${clockTime(since)}` : 'offline',
    })
  }

  // Talos mod
  switch (s.mod.state) {
    case 'alive':
      rows.push({ id: 'mod', label: 'Talos mod', tone: 'ok', detail: `reporting · ${agoAt(s.mod.last_seen, now)}` })
      break
    case 'quiet':
      rows.push({
        id: 'mod',
        label: 'Talos mod',
        tone: 'warn',
        detail: s.mod.last_seen ? `quiet · last heard ${agoAt(s.mod.last_seen, now)}` : 'quiet',
      })
      break
    case 'absent':
      rows.push({ id: 'mod', label: 'Talos mod', tone: 'idle', detail: 'Not installed' })
      break
    default:
      rows.push({ id: 'mod', label: 'Talos mod', tone: 'idle', detail: 'Unknown while your Mac is offline' })
  }

  // Mac disk: only from a live bridge that reports it (an older bridge sends nothing, and an offline Mac's last number is
  // history). Red below the line the push uses, amber until it is clearly back above it.
  const free = s.beat?.disk_free_bytes
  if (s.bridge.online && free !== undefined) {
    const low = free < DISK_LOW_BYTES
    rows.push({
      id: 'disk',
      label: 'Mac disk',
      tone: low ? 'bad' : free < DISK_RECOVERED_BYTES ? 'warn' : 'ok',
      detail: low ? `nearly full · ${formatFree(free)} free` : `${formatFree(free)} free`,
    })
  }

  // Scheduler (the cached schedule.status, when schedules/1 is on)
  if (extra.scheduler) {
    const st = extra.scheduler.state
    const tone: Tone = st === null ? 'idle' : st === 'ok' ? 'ok' : st === 'paused' || st === 'off' ? 'warn' : 'bad'
    rows.push({
      id: 'scheduler',
      label: 'Scheduler',
      tone,
      detail: st === null ? 'not checked yet' : st.replace('_', ' '),
    })
  }

  // Phone alerts
  if (s.relay_problems.includes('no_alert_path')) {
    rows.push({ id: 'alerts', label: 'Phone alerts', tone: 'bad', detail: 'Nobody can be alerted' })
  } else {
    const parts: string[] = []
    if (s.push.subscriptions > 0) parts.push('push on this device')
    if (s.ntfy) parts.push('ntfy on')
    const failed =
      s.push.last_error_at !== null &&
      (s.push.last_ok_at === null || Date.parse(s.push.last_error_at) > Date.parse(s.push.last_ok_at))
    if (failed) parts.push(`last push failed ${agoAt(s.push.last_error_at, now)}`)
    rows.push({ id: 'alerts', label: 'Phone alerts', tone: failed ? 'warn' : 'ok', detail: parts.join(' · ') })
  }
  return rows
}

/** The two things the Mac's beat can say that are not a problem with a row. */
export function healthNotes(s: HealthStatusT): string[] {
  const out: string[] = []
  if (s.beat?.tts === false) out.push('Voice replies need a TTS command on your Mac')
  if (s.beat?.sqlite?.fts5 === false) out.push("Search is off: this Mac's SQLite has no FTS5")
  return out
}

/** The four ways the Mac can be a problem. One banner per state, wherever it shows (Home banners, the thread screens). */
export type MacState = 'dropped' | 'asleep' | 'key_refused' | 'mod_quiet'
export type MacMessage = {
  kind: MacState /** What happened, in plain words. */
  cause: string /** What to do about it. */
  next: string
}

/** The Mac counts as gone (asleep, or its session stopped) after this long offline: the relay's BRIDGE_GONE_MS. */
export const MAC_GONE_MS = 5 * 60_000

const lastSeenNote = (lastSeen: string | null | undefined, nowMs: number) => {
  if (!lastSeen) return ''
  const r = relativeTime(lastSeen, nowMs)
  return ` (last seen ${r === 'now' || r === '' ? 'just now' : `${r} ago`})`
}

/** The one place the Mac-problem wording lives. Each state says what happened and what to do, with no jargon. */
export function macMessage(
  kind: MacState,
  ctx: { lastSeen?: string | null; nowMs?: number; bufferDays?: number | undefined } = {},
): MacMessage {
  const days = ctx.bufferDays === undefined ? '7 days' : ctx.bufferDays === 1 ? '1 day' : `${ctx.bufferDays} days`
  const seen = lastSeenNote(ctx.lastSeen, ctx.nowMs ?? Date.now())
  switch (kind) {
    case 'dropped':
      return {
        kind,
        cause: `Your Mac is offline${seen}. Its connection to the server just dropped.`,
        next: `It usually comes back on its own within a few minutes. Your messages wait on the server for up to ${days}.`,
      }
    case 'asleep':
      return {
        kind,
        cause: `Your Mac is offline${seen}. It is probably asleep, or the Claude session on it has stopped.`,
        next: `Wake the Mac and check that Claude is still running in its terminal. Your messages wait on the server for up to ${days}.`,
      }
    case 'key_refused':
      return {
        kind,
        cause: "Your Mac is offline: the server turned away its key, so it can't connect.",
        next: 'On the Mac, run talos-app doctor. It prints the key line your server needs: paste it into your server settings and deploy again. The setup guide has the steps.',
      }
    case 'mod_quiet':
      return {
        kind,
        cause: 'Your mod stopped reporting.',
        next: 'Check that Claude is still running on your Mac with the Talos mod loaded.',
      }
  }
}

/**
 * Offline from the live presence frame (no status needed): just dropped, or gone long enough to be asleep / stopped. Null
 * while the Mac is online.
 */
export function presenceMacState(online: boolean, lastSeen: string | null, nowMs: number): 'dropped' | 'asleep' | null {
  if (online) return null
  const seen = lastSeen ? Date.parse(lastSeen) : Number.NaN
  return Number.isFinite(seen) && nowMs - seen <= MAC_GONE_MS ? 'dropped' : 'asleep'
}

export type HealthBannerInfo = {
  kind: 'mod_quiet' | 'bridge_offline' | 'key_refused'
  /** The cause line. */
  text: string
  /** What to do. */
  next: string
}

/**
 * Home banner (V2.5): `mod_quiet` always; `key_refused` always (a refused key is not a closed lid); `bridge_offline` only
 * outside the quiet window (a closed lid at night is normal). A Mac that just dropped is the presence banner's.
 */
export function bannerFor(
  s: HealthStatusT,
  inQuietWindow: boolean,
  nowMs: number = Date.parse(s.at),
): HealthBannerInfo | null {
  const pick = (kind: HealthBannerInfo['kind'], state: MacState): HealthBannerInfo => {
    const m = macMessage(state, { lastSeen: s.bridge.last_seen, nowMs, bufferDays: s.limits?.buffer_days })
    return { kind, text: m.cause, next: m.next }
  }
  if (!s.bridge.online && s.bridge.auth_refused_at) return pick('key_refused', 'key_refused')
  if (s.mac_problems.includes('mod_quiet')) return pick('mod_quiet', 'mod_quiet')
  if (s.mac_problems.includes('bridge_offline') && !inQuietWindow) return pick('bridge_offline', 'asleep')
  return null
}

export const NOBODY = 'Nobody to alert: no subscribed device and ntfy off.'

type TestBody = { push?: { sent: number; ok: number }; ntfy?: string } | undefined

/** What the test button may claim. It never says "sent" unless something was accepted (or the relay predates the report). */
export function testOutcome(body: TestBody, noAlertPath: boolean): { kind: 'sent' | 'failed'; text: string } {
  if (!body) {
    // an older relay answers 204 with no report: trust the screen's own "nobody can be alerted"
    return noAlertPath
      ? { kind: 'failed', text: NOBODY }
      : { kind: 'sent', text: 'Test alert sent. It should arrive in a few seconds.' }
  }
  const pushOk = (body.push?.ok ?? 0) > 0
  const ntfyOk = body.ntfy === 'sent'
  if (pushOk || ntfyOk) {
    const via = [pushOk ? 'push' : '', ntfyOk ? 'ntfy' : ''].filter(Boolean).join(' and ')
    return { kind: 'sent', text: `Test alert sent by ${via}. It should arrive in a few seconds.` }
  }
  if ((body.push?.sent ?? 0) === 0 && body.ntfy !== 'failed') return { kind: 'failed', text: NOBODY }
  return { kind: 'failed', text: "The test alert didn't go through. Check the push subscription and ntfy." }
}
