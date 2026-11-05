// Jira normalizer for three shapes: a polled issue (with changelog and comments), an Automation rule body, and an admin
// webhook. Every string is cleaned to plain text; the issue link is built from the validated site, never taken on trust.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'
import { validSite } from './poll.ts'

type Kind = 'jira.assigned' | 'jira.comment' | 'jira.status'
const PRIORITY: Record<Kind, 'high' | 'normal'> = {
  'jira.assigned': 'high',
  'jira.comment': 'normal',
  'jira.status': 'normal',
}

/** Atlassian Document Format -> plain text (text nodes only). */
export function adfText(node: unknown, depth = 0): string {
  if (typeof node === 'string') return node
  if (!isRecord(node) || depth > 12) return ''
  if (typeof node.text === 'string') return node.text
  const kids = Array.isArray(node.content)
    ? node.content.map((c) => adfText(c, depth + 1)).join(node.type === 'doc' ? ' ' : '')
    : ''
  return kids
}

/** The configured Jira site, validated. Empty when it is missing or not a *.atlassian.net host. */
function siteOf(conn: NormalizeConnection): string {
  const s = (conn.extra.site ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '')
  return validSite(s) ? s : ''
}

function browse(site: string, key: string): string | undefined {
  return validSite(site) && /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/.test(key) ? `https://${site}/browse/${key}` : undefined
}

function polled(raw: RawDelivery, conn: NormalizeConnection, j: Record<string, unknown>): NormalizedEventT[] {
  // Only the relay's own poller reaches here (selected by its header, never by a body key). The link comes from the
  // configured site, not from anything the body says.
  const t = isRecord(j.talos) ? j.talos : {}
  const site = siteOf(conn)
  const me = typeof t.me === 'string' ? t.me : ''
  const since = typeof t.since === 'number' ? t.since : 0
  const issue = isRecord(j.issue) ? j.issue : undefined
  if (!issue || typeof issue.key !== 'string') return []
  const key = clean(issue.key, 40)
  const f = isRecord(issue.fields) ? issue.fields : {}
  const summary = clean(f.summary, 200)
  const url = browse(site, key)
  const out: NormalizedEventT[] = []
  const add = (kind: Kind, who: string, what: string, at: unknown, dedup: string, actorId?: string) =>
    out.push(
      makeEvent(conn, 'jira', {
        kind,
        title: `${key} ${summary}`,
        summary: `${what}`,
        url,
        actor: { ...(who ? { name: who } : {}), ...(actorId ? { id: actorId } : {}) },
        ts: toIso(at, raw.receivedAt),
        priority: PRIORITY[kind],
        dedup_key: `jira:${key}:${dedup}`,
      }),
    )
  const histories =
    isRecord(issue.changelog) && Array.isArray(issue.changelog.histories) ? issue.changelog.histories : []
  for (const h of histories) {
    if (!isRecord(h) || Date.parse(String(h.created)) < since) continue
    const author = isRecord(h.author) ? h.author : {}
    if (author.accountId === me) continue // the owner's own change
    const who = clean(author.displayName, 80)
    for (const it of Array.isArray(h.items) ? h.items : []) {
      if (!isRecord(it)) continue
      if (it.field === 'assignee' && it.to === me)
        add(
          'jira.assigned',
          who,
          `${who || 'Someone'} assigned ${key} to you: ${summary}`,
          h.created,
          `cl${clean(h.id, 20)}:assignee`,
          typeof author.accountId === 'string' ? author.accountId : undefined,
        )
      else if (it.field === 'status')
        add(
          'jira.status',
          who,
          `${key} moved from ${clean(it.fromString, 60)} to ${clean(it.toString, 60)}${who ? ` by ${who}` : ''}`,
          h.created,
          `cl${clean(h.id, 20)}:status`,
        )
    }
  }
  const comments = isRecord(f.comment) && Array.isArray(f.comment.comments) ? f.comment.comments : []
  for (const c of comments) {
    if (!isRecord(c) || Date.parse(String(c.created)) < since) continue
    const author = isRecord(c.author) ? c.author : {}
    if (author.accountId === me) continue
    const who = clean(author.displayName, 80)
    add(
      'jira.comment',
      who,
      `${who || 'Someone'} commented on ${key}: ${clean(adfText(c.body), 220)}`,
      c.created,
      `c${clean(c.id, 20)}`,
      typeof author.accountId === 'string' ? author.accountId : undefined,
    )
  }
  // Assigned to the owner, created inside the window, and no changelog entry told us: a brand-new issue.
  const assignee = isRecord(f.assignee) ? f.assignee : {}
  if (out.length === 0 && assignee.accountId === me && Date.parse(String(f.created)) >= since) {
    const rep = isRecord(f.reporter) ? clean(f.reporter.displayName, 80) : ''
    add('jira.assigned', rep, `${rep || 'Someone'} created ${key} for you: ${summary}`, f.created, 'created')
  }
  return out
}

const KIND_WORDS: Record<string, Kind> = {
  assigned: 'jira.assigned',
  assign: 'jira.assigned',
  comment: 'jira.comment',
  commented: 'jira.comment',
  status: 'jira.status',
  transition: 'jira.status',
  transitioned: 'jira.status',
}

/** Automation rule body. The owner's rule decides the shape; see docs/integrations/jira.md for the one we suggest. */
function automation(raw: RawDelivery, conn: NormalizeConnection, j: Record<string, unknown>): NormalizedEventT[] {
  const issue = isRecord(j.issue) ? j.issue : j
  const key = clean(issue.key ?? j.key, 40)
  const summary = clean(issue.summary ?? j.summary ?? j.title, 200)
  if (!key && !summary) return []
  const kind = KIND_WORDS[String(j.kind ?? j.event ?? '').toLowerCase()] ?? 'jira.status'
  const who = clean(j.initiator ?? j.actor, 80)
  const text = clean(j.comment ?? j.text ?? issue.status ?? '', 220)
  const nonce = clean(raw.headers['idempotency-key'] ?? raw.headers['webhook-id'] ?? '', 100) || `${raw.receivedAt}`
  return [
    makeEvent(conn, 'jira', {
      kind,
      title: `${key} ${summary}`.trim(),
      summary: `${who ? `${who}: ` : ''}${text || summary}`,
      url: browse(siteOf(conn), key),
      actor: who ? { name: who } : {},
      ts: toIso(j.updated, raw.receivedAt),
      priority: PRIORITY[kind],
      dedup_key: `jira:auto:${key}:${kind}:${nonce}`,
    }),
  ]
}

/** Admin webhook (`jira:issue_updated`, `comment_created`, …). */
function adminHook(raw: RawDelivery, conn: NormalizeConnection, j: Record<string, unknown>): NormalizedEventT[] {
  const issue = isRecord(j.issue) ? j.issue : undefined
  if (!issue || typeof issue.key !== 'string') return []
  const f = isRecord(issue.fields) ? issue.fields : {}
  const key = clean(issue.key, 40)
  const summary = clean(f.summary, 200)
  const user = isRecord(j.user) ? clean(j.user.displayName, 80) : ''
  const id = clean(raw.headers['x-atlassian-webhook-identifier'], 100) || `${raw.receivedAt}`
  const ev = String(j.webhookEvent ?? '')
  let kind: Kind = 'jira.status'
  let text = `${key} was updated`
  if (ev.startsWith('comment_') && isRecord(j.comment)) {
    kind = 'jira.comment'
    text = `${user || 'Someone'} commented: ${clean(adfText(j.comment.body), 220)}`
  } else if (isRecord(j.changelog) && Array.isArray(j.changelog.items)) {
    const items = j.changelog.items.filter(isRecord)
    if (items.some((i) => i.field === 'assignee')) kind = 'jira.assigned'
    text = items.map((i) => `${clean(i.field, 40)}: ${clean(i.toString, 60)}`).join(', ') || text
  }
  return [
    makeEvent(conn, 'jira', {
      kind,
      title: `${key} ${summary}`,
      summary: user ? `${user} · ${text}` : text,
      url: browse(siteOf(conn), key),
      actor: user ? { name: user } : {},
      ts: toIso(j.timestamp, raw.receivedAt),
      priority: PRIORITY[kind],
      dedup_key: `jira:hook:${id}`,
    }),
  ]
}

export function normalizeJira(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j)) return []
  if (raw.headers['x-talos-poll'] === 'jira') return polled(raw, conn, j)
  if (typeof j.webhookEvent === 'string') return adminHook(raw, conn, j)
  return automation(raw, conn, j)
}

export function jiraToggle(key: string, enabled: boolean, event: NormalizedEventT): boolean {
  const map: Record<string, string> = { assigned: 'jira.assigned', comments: 'jira.comment', status: 'jira.status' }
  return map[key] === event.kind ? enabled : true
}

/**
 * Spec 7.1 step 2. Polled items (relay header) were already narrowed by JQL. A pushed body is kept only when it names an
 * issue key; once the owner's account id is known (`extra.account_id`), it must also mention it.
 */
export function jiraPrefilter(raw: RawDelivery, conn: NormalizeConnection): boolean {
  if (raw.headers['x-talos-poll'] === 'jira') return true
  const j = parseJson(raw)
  if (!isRecord(j)) return false
  const issue = isRecord(j.issue) ? j.issue : j
  if (typeof (issue.key ?? j.key) !== 'string' || !(issue.key ?? j.key)) return false
  const id = conn.extra.account_id
  return id ? new TextDecoder().decode(raw.rawBody).includes(id) : true
}
