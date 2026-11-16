// Slack message -> NormalizedEvent. Text is Slack mrkdwn: tokens are turned into plain words, everything else stays plain
// text (the bridge wraps it as untrusted). Names are not resolved: nothing here calls the Slack API.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, makeEvent, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { parseSlackMessage, slackKind } from './events.ts'

/** `<@U1>` -> `@U1`, `<#C1|general>` -> `#general`, `<https://x|label>` -> `label`, `<!here>` -> `@here`, entities decoded. */
export function plainSlackText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `@${name || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#([A-Z0-9]+)>/g, '#$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<!([a-z]+)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(?:https?:|mailto:)[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<((?:https?:|mailto:)[^>]*)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const TITLE: Record<string, (who: string) => string> = {
  'slack.dm': (who) => `Direct message from ${who}`,
  'slack.mpim': (who) => `Group message from ${who}`,
  'slack.mention': (who) => `${who} mentioned you`,
  'slack.bot_dm': (who) => `Direct message to the bot from ${who}`,
  'slack.bot_mpim': (who) => `Group message to the bot from ${who}`,
  'slack.bot_mention': (who) => `${who} mentioned the bot`,
}

export function normalizeSlack(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const m = parseSlackMessage(raw, conn)
  if (!m) return []
  const kind = slackKind(m, conn)
  if (!kind) return []
  const body = clean(plainSlackText(m.text), 1000)
  const who = m.user ? `@${m.user}` : 'Someone'
  const tsSeconds = Number(m.ts.split('.')[0])
  const link =
    m.teamId && /^[A-Z0-9]+$/.test(m.channel) && /^[A-Z0-9]+$/.test(m.teamId)
      ? `https://app.slack.com/client/${m.teamId}/${m.channel}`
      : undefined
  return [
    makeEvent(conn, 'slack', {
      kind,
      title: TITLE[kind]?.(who) ?? `${who} sent a message`,
      summary: body ? `${who}: ${body}` : `${who} sent a message`,
      url: link,
      actor: m.user ? { id: m.user } : {},
      ts: toIso(Number.isFinite(tsSeconds) ? tsSeconds : undefined, raw.receivedAt),
      priority: 'high',
      dedup_key: `slack:${m.eventId || `${m.channel}:${m.ts}`}`,
    }),
  ]
}

const KINDS_FOR: Record<string, readonly string[]> = {
  dms: ['slack.dm', 'slack.bot_dm'],
  group_dms: ['slack.mpim', 'slack.bot_mpim'],
  mentions: ['slack.mention', 'slack.bot_mention'],
}

/** Toggle keys are the setup filters: dms, group_dms, mentions. Each covers the owner's kind and the bot's. */
export function slackToggle(key: string, enabled: boolean, event: NormalizedEventT): boolean {
  return KINDS_FOR[key]?.includes(event.kind) ? enabled : true
}
