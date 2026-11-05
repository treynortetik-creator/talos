// Slack event parsing shared by the pre-filter and the normalizer.
import { isRecord, parseJson } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

export type SlackMessage = {
  teamId: string
  eventId: string
  channel: string
  channelType: string
  user: string
  text: string
  ts: string
  threadTs: string
  ownerId: string
}

// Message subtypes that are real new messages. Edits, deletions, joins and the like are dropped.
const REAL_SUBTYPES = new Set(['thread_broadcast', 'file_share', 'bot_message', 'me_message'])

export function ownerId(raw: RawDelivery, conn: NormalizeConnection): string {
  const fromConn = (conn.extra.owner_slack_id ?? '').trim()
  if (fromConn) return fromConn
  const j = parseJson(raw)
  if (isRecord(j) && Array.isArray(j.authorizations)) {
    const a = j.authorizations.find((x) => isRecord(x) && typeof x.user_id === 'string' && x.is_bot !== true)
    if (isRecord(a) && typeof a.user_id === 'string') return a.user_id
  }
  return ''
}

/** The message in an `event_callback`, or null for anything else (handshakes, rate-limit notices, non-messages, edits). */
export function parseSlackMessage(raw: RawDelivery, conn: NormalizeConnection): SlackMessage | null {
  const j = parseJson(raw)
  if (!isRecord(j) || j.type !== 'event_callback' || !isRecord(j.event)) return null
  const e = j.event
  if (e.type !== 'message') return null
  if (typeof e.subtype === 'string' && !REAL_SUBTYPES.has(e.subtype)) return null
  if (typeof e.channel !== 'string' || typeof e.ts !== 'string') return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    teamId: str(j.team_id),
    eventId: str(j.event_id),
    channel: e.channel,
    channelType: str(e.channel_type),
    user: str(e.user) || str(e.bot_id),
    text: str(e.text),
    ts: e.ts,
    threadTs: str(e.thread_ts),
    ownerId: ownerId(raw, conn),
  }
}

export function mentionsOwner(text: string, owner: string): boolean {
  return owner !== '' && text.includes(`<@${owner}>`)
}
