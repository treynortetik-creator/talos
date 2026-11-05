// Normalizer for GitHub notification-poll items (`GET /notifications`). Webhook deliveries are WP3b's `webhooks.ts`.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

type Kind = 'github.mention' | 'github.review_requested' | 'github.assign' | 'github.ci_failed' | 'github.event'

export function kindFor(reason: string, title: string): Kind {
  switch (reason) {
    case 'mention':
    case 'team_mention':
      return 'github.mention'
    case 'review_requested':
      return 'github.review_requested'
    case 'assign':
      return 'github.assign'
    case 'ci_activity':
      return /fail/i.test(title) ? 'github.ci_failed' : 'github.event'
    default:
      return 'github.event'
  }
}

const HIGH = new Set<Kind>(['github.mention', 'github.review_requested', 'github.assign', 'github.ci_failed'])

/** API URL -> the page a person would open. Only known shapes are converted; anything else falls back to the repo. */
export function htmlUrl(apiUrl: unknown, repoHtml: unknown): string | undefined {
  const repo = typeof repoHtml === 'string' ? repoHtml : undefined
  if (typeof apiUrl === 'string') {
    const m =
      /^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/(pulls|issues|commits|releases)\/([\w.-]+)$/.exec(
        apiUrl,
      )
    if (m) {
      const [, o, r, kind, id] = m
      const seg =
        kind === 'pulls' ? 'pull' : kind === 'commits' ? 'commit' : kind === 'releases' ? 'releases' : 'issues'
      return kind === 'releases' ? `https://github.com/${o}/${r}/releases` : `https://github.com/${o}/${r}/${seg}/${id}`
    }
  }
  return repo
}

const ACTION: Record<string, string> = {
  mention: 'mentioned you in',
  team_mention: 'mentioned your team in',
  review_requested: 'requested your review on',
  assign: 'assigned you to',
  ci_activity: 'build update for',
  author: 'activity on your',
  comment: 'commented on',
  subscribed: 'activity in',
  state_change: 'state changed on',
  manual: 'activity on',
  approval_requested: 'approval requested for',
  security_alert: 'security alert for',
}

export function normalizeNotification(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const n = parseJson(raw)
  if (!isRecord(n) || !isRecord(n.subject)) return []
  const reason = typeof n.reason === 'string' ? n.reason : ''
  const title = clean(n.subject.title, 200)
  const repo = isRecord(n.repository) ? n.repository : {}
  const fullName = clean(repo.full_name, 120)
  const kind = kindFor(reason, title)
  const id = clean(n.id, 60)
  const updated = typeof n.updated_at === 'string' ? n.updated_at : ''
  return [
    makeEvent(conn, 'github', {
      kind,
      title: kind === 'github.review_requested' ? `Review requested: ${title}` : title,
      summary: `${ACTION[reason] ?? 'activity on'} ${fullName || 'a repository'}: ${title}`,
      url: htmlUrl(n.subject.url, repo.html_url),
      actor: fullName ? { name: fullName } : {},
      ts: toIso(updated, raw.receivedAt),
      priority: HIGH.has(kind) ? 'high' : 'low',
      dedup_key: `github:notif:${id}:${updated}`,
    }),
  ]
}

export function githubToggle(key: string, enabled: boolean, event: NormalizedEventT): boolean {
  const map: Record<string, string[]> = {
    mentions: ['github.mention'],
    review_requests: ['github.review_requested'],
    assigned: ['github.assign'],
    ci_failed: ['github.ci_failed'],
  }
  if (key === 'other') return enabled || event.kind !== 'github.event'
  const kinds = map[key]
  return kinds?.includes(event.kind) ? enabled : true
}
