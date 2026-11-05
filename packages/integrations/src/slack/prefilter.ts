// Runs right after verification and before anything is stored (spec 7.1 step 2): keep `im` and `mpim` messages, and
// channel messages that mention the owner. Everything else gets a 200 and is never stored. The owner's own messages go too.
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { mentionsOwner, parseSlackMessage } from './events.ts'

export function slackPrefilter(raw: RawDelivery, conn: NormalizeConnection): boolean {
  const m = parseSlackMessage(raw, conn)
  if (!m) return false
  if (m.ownerId && m.user === m.ownerId) return false
  if (m.channelType === 'im' || m.channelType === 'mpim') return true
  return mentionsOwner(m.text, m.ownerId)
}
