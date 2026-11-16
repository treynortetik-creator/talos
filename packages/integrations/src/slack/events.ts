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
  /** The event's `subtype` ('' for a plain message). */
  subtype: string
  /** Set when a bot (any app) posted the message. */
  botId: string
  /** The app that posted the message (`event.app_id`), when an app did. */
  appId: string
  /** The bot user this delivery was authorized for ('' when none: the event came for a person). */
  botAuth: string
}

/** Whose Slack a connection listens to: the owner's own account (user events) or an agent's bot user (bot events). */
export type SlackIdentity = 'owner' | 'bot'

export function identityOf(conn: NormalizeConnection): SlackIdentity {
  return conn.extra.identity === 'bot' ? 'bot' : 'owner'
}

/** The bot user id a bot connection belongs to: set in setup, or learned from its first event (relay, `learn`). */
export function botUserId(conn: NormalizeConnection): string {
  return (conn.extra.bot_user_id ?? '').trim()
}

/** The bot user ids of this owner's bot connections, passed in by the relay (`siblingExtra`). */
export function siblingBotIds(conn: NormalizeConnection): Set<string> {
  return new Set((conn.extra.sibling_bot_ids ?? '').split(',').filter(Boolean))
}

/** The app ids of this owner's bot connections (a bot posting under a custom name has no user id, only its app's). */
export function siblingBotApps(conn: NormalizeConnection): Set<string> {
  return new Set((conn.extra.sibling_bot_apps ?? '').split(',').filter(Boolean))
}

/** The app a bot connection belongs to: learned from its first event's `api_app_id`. */
export function botAppId(conn: NormalizeConnection): string {
  return (conn.extra.bot_app_id ?? '').trim()
}

/** The bot authorization an event was delivered for (`authorizations[]` with `is_bot: true`), or ''. */
export function botAuthorization(raw: RawDelivery): string {
  const j = parseJson(raw)
  if (!isRecord(j) || !Array.isArray(j.authorizations)) return ''
  const a = j.authorizations.find((x) => isRecord(x) && typeof x.user_id === 'string' && x.is_bot === true)
  return isRecord(a) && typeof a.user_id === 'string' ? a.user_id : ''
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
    subtype: str(e.subtype),
    botId: str(e.bot_id),
    appId: str(e.app_id),
    botAuth: botAuthorization(raw),
  }
}

export function mentionsOwner(text: string, owner: string): boolean {
  return owner !== '' && text.includes(`<@${owner}>`)
}

/** The kind a message becomes on this connection, or null when it is dropped before storage. */
export function slackKind(m: SlackMessage, conn: NormalizeConnection): string | null {
  const dm = m.channelType === 'im'
  const group = m.channelType === 'mpim'
  if (identityOf(conn) === 'bot') {
    // Loop guard: a bot connection never takes a bot's message, its own above all (the agent's replies come back as
    // events). No learned id is needed for this, so it holds from the first event.
    const bot = botUserId(conn)
    // Only what Slack delivered for this bot: an event for a person (the same app with user scopes) is not the bot's.
    if (!m.botAuth || (bot && m.botAuth !== bot)) return null
    if (m.subtype === 'bot_message' || m.botId || (bot && m.user === bot)) return null
    if (dm) return 'slack.bot_dm'
    if (group) return 'slack.bot_mpim'
    return mentionsOwner(m.text, bot) ? 'slack.bot_mention' : null
  }
  if (m.ownerId && m.user === m.ownerId) return null
  // Loop guard the other way: what the owner's own agents' bots say is not news to the owner. (While a new bot connection
  // has not learned its bot yet, bots' messages are refused before this, in `learn`: identity.ts.)
  if (m.user && siblingBotIds(conn).has(m.user)) return null
  if (m.appId && siblingBotApps(conn).has(m.appId)) return null
  if (dm) return 'slack.dm'
  if (group) return 'slack.mpim'
  return mentionsOwner(m.text, m.ownerId) ? 'slack.mention' : null
}
