// Runs right after verification and before anything is stored (spec 7.1 step 2). The owner's connection keeps `im` and
// `mpim` messages and channel messages that mention the owner; a bot connection keeps the same addressed to its bot.
// Everything else gets a 200 and is never stored: the owner's own messages, and bots' messages (the loop guards, events.ts).
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { parseSlackMessage, slackKind } from './events.ts'

export function slackPrefilter(raw: RawDelivery, conn: NormalizeConnection): boolean {
  const m = parseSlackMessage(raw, conn)
  return m !== null && slackKind(m, conn) !== null
}
