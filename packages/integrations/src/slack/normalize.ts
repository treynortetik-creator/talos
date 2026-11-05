// Slack message -> NormalizedEvent. Text is Slack mrkdwn: tokens are turned into plain words, everything else stays plain
// text (the bridge wraps it as untrusted). Names are not resolved: nothing here calls the Slack API.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, makeEvent, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { mentionsOwner, parseSlackMessage } from './events.ts'

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

export function normalizeSlack(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const m = parseSlackMessage(raw, conn)
  if (!m) return []
  const dm = m.channelType === 'im'
  const group = m.channelType === 'mpim'
  const mention = mentionsOwner(m.text, m.ownerId)
  if (!dm && !group && !mention) return []
  const kind = dm ? 'slack.dm' : group ? 'slack.mpim' : 'slack.mention'
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
      title: dm ? `Direct message from ${who}` : group ? `Group message from ${who}` : `${who} mentioned you`,
      summary: body ? `${who}: ${body}` : `${who} sent a message`,
      url: link,
      actor: m.user ? { id: m.user } : {},
      ts: toIso(Number.isFinite(tsSeconds) ? tsSeconds : undefined, raw.receivedAt),
      priority: 'high',
      dedup_key: `slack:${m.eventId || `${m.channel}:${m.ts}`}`,
    }),
  ]
}

const KIND_FOR: Record<string, string> = { dms: 'slack.dm', group_dms: 'slack.mpim', mentions: 'slack.mention' }

/** Toggle keys are the setup filters: dms, group_dms, mentions. */
export function slackToggle(key: string, enabled: boolean, event: NormalizedEventT): boolean {
  return KIND_FOR[key] === event.kind ? enabled : true
}
