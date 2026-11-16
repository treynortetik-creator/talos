// Which bot a bot connection is, and what the owner's connection must know about its siblings (the loop guards).
// A bot connection learns its bot user id and app id from the first signed event Slack sends it (`authorizations[]` with
// `is_bot: true`, and `api_app_id`); an id set in setup wins and is never replaced. After that an event for a different
// bot or app is refused, not learned: a signing secret pasted into the wrong connection must not quietly turn it into
// another bot's. An event that was not delivered for a bot at all (the same app with user scopes: the owner's own DMs) is
// refused too.
import { isRecord, parseJson, type SiblingConnection } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { botAppId, botAuthorization, botUserId, identityOf, parseSlackMessage } from './events.ts'

const BOT_USER_ID = /^[UW][A-Z0-9]{2,20}$/
const APP_ID = /^A[A-Z0-9]{2,20}$/
/**
 * How long after a bot connection is made the owner's connection holds back bots' messages while that bot is not known
 * yet. A bot connection that never hears from Slack (set up, never installed) stops holding anything back after this.
 */
export const BOT_LEARN_WINDOW_MS = 24 * 3_600_000

export function slackLearn(
  raw: RawDelivery,
  conn: NormalizeConnection,
): { extra: Record<string, string> } | { refuse: string } | null {
  const j = parseJson(raw)
  if (!isRecord(j) || j.type !== 'event_callback') return null // handshakes, rate-limit notices: nothing to learn
  if (identityOf(conn) !== 'bot') {
    // The owner's connection, while a new bot connection has not learned its bot: a bot's message might be that bot's,
    // so it is refused with its own reason (Recent deliveries shows it). People's messages are never held back.
    if (conn.extra.sibling_bot_unknown !== '1') return null
    const m = parseSlackMessage(raw, conn)
    return m && (m.botId || m.subtype === 'bot_message') ? { refuse: 'held_bot_unknown' } : null
  }
  const seen = botAuthorization(raw)
  if (!BOT_USER_ID.test(seen)) return { refuse: 'not_bot' }
  const app = typeof j.api_app_id === 'string' && APP_ID.test(j.api_app_id) ? j.api_app_id : ''
  const knownBot = botUserId(conn)
  const knownApp = botAppId(conn)
  if ((knownBot && knownBot !== seen) || (knownApp && app && knownApp !== app)) return { refuse: 'other_bot' }
  const extra: Record<string, string> = {}
  if (!knownBot) extra.bot_user_id = seen
  if (!knownApp && app) extra.bot_app_id = app
  return Object.keys(extra).length ? { extra } : null
}

/**
 * The owner's connection drops what its bot connections' bots say: their user ids and app ids. While a bot connection
 * made (or given a new bot id or secret) in the last `BOT_LEARN_WINDOW_MS` has not learned its bot (user and app) yet, it also holds back every bot's
 * message (`sibling_bot_unknown`, refused in `slackLearn`); after that window an unlearned bot connection holds nothing
 * back. With no bot connection, nothing is passed. A bot connection needs nothing from its siblings.
 */
export function slackSiblingExtra(
  conn: NormalizeConnection,
  siblings: SiblingConnection[],
  now: number,
): Record<string, string> {
  if (identityOf(conn) === 'bot') return {}
  const bots = siblings.filter((s) => s.id !== conn.id && identityOf(s) === 'bot')
  const ids = [...new Set(bots.map(botUserId).filter((id) => BOT_USER_ID.test(id)))].sort()
  const apps = [...new Set(bots.map(botAppId).filter((id) => APP_ID.test(id)))].sort()
  const out: Record<string, string> = {}
  if (ids.length) out.sibling_bot_ids = ids.join(',')
  if (apps.length) out.sibling_bot_apps = apps.join(',')
  // Learning since it was made, or since a new bot id or secret was saved (`bot_relearn_at`, set by the relay).
  const since = (b: SiblingConnection) => Math.max(b.createdAt, Number(b.extra.bot_relearn_at) || 0)
  const learning = (b: SiblingConnection) =>
    (!BOT_USER_ID.test(botUserId(b)) || !APP_ID.test(botAppId(b))) && now - since(b) < BOT_LEARN_WINDOW_MS
  if (bots.some(learning)) out.sibling_bot_unknown = '1'
  return out
}
