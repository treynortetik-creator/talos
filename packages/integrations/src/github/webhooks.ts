// GitHub per-repo webhooks (spec 7.2 row `github`, 7.5): `X-Hub-Signature-256` = `sha256=` + hex HMAC-SHA256(secret, raw
// body). GitHub sends no timestamp, so there is no replay window; replays are stopped by the `X-GitHub-Delivery` dedup
// key (kept 90 days by the relay). `./index.ts` (WP3) calls `webhookVerify` and `normalizeWebhook`; keep the signatures.
import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import { hmacSha256, safeEqual } from '../standard-webhooks.ts'
import type { NormalizeConnection, RawDelivery, VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

const SIG = /^sha256=([0-9a-f]{64})$/

export function webhookVerify(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const header = req.headers['x-hub-signature-256']
  const delivery = req.headers['x-github-delivery']
  if (!header || !delivery || !req.headers['x-github-event']) return { ok: false, reason: 'missing_header' }
  if (delivery.length > 128) return { ok: false, reason: 'bad_id' }
  const m = SIG.exec(header.trim().toLowerCase())
  if (!m) return { ok: false, reason: 'bad_signature_format' }
  const given = m[1] as string
  if (conn.secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  for (const secret of conn.secrets) {
    if (safeEqual(hmacSha256(secret, req.rawBody).toString('hex'), given))
      return { ok: true, deliveryKey: `gh:${delivery}` }
  }
  return { ok: false, reason: 'signature_mismatch' }
}

function login(extra: Record<string, string>): string {
  return (extra.login ?? '').trim().replace(/^@/, '').toLowerCase()
}

const str = (v: unknown, max: number) => clean(v, max)
const loginOf = (v: unknown) => (isRecord(v) && typeof v.login === 'string' ? v.login : '')

function mentions(text: unknown, me: string): boolean {
  if (!me || typeof text !== 'string') return false
  const esc = me.replace(/[-.]/g, (c) => `\\${c}`)
  return new RegExp(`(^|[^\\w@/.-])@${esc}(?![\\w-])`, 'i').test(text)
}

export function normalizeWebhook(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const ev = raw.headers['x-github-event'] ?? ''
  const delivery = raw.headers['x-github-delivery'] ?? ''
  const p = parseJson(raw)
  if (!isRecord(p) || ev === 'ping') return []
  const me = login(conn.extra)
  const action = typeof p.action === 'string' ? p.action : ''
  const repo = isRecord(p.repository) ? str(p.repository.full_name, 120) : ''
  const sender = isRecord(p.sender) ? p.sender : {}
  const actor = loginOf(sender) ? { name: str(loginOf(sender), 120) } : {}
  const where = repo || 'a repository'
  const mk = (
    kind: string,
    title: string,
    summary: string,
    url: unknown,
    priority: 'high' | 'normal' | 'low',
    ts: unknown,
  ) =>
    makeEvent(conn, 'github', {
      kind,
      title,
      summary,
      url,
      actor,
      ts: toIso(ts, raw.receivedAt),
      priority,
      dedup_key: `github:hook:${delivery || `${ev}:${action}:${str(title, 60)}`}`,
    })

  const issue = isRecord(p.issue) ? p.issue : isRecord(p.pull_request) ? p.pull_request : undefined

  if (ev === 'workflow_run' && isRecord(p.workflow_run)) {
    const w = p.workflow_run
    if (action === 'completed' && w.conclusion === 'failure') {
      const name = str(w.name, 120) || 'Workflow'
      return [
        mk(
          'github.ci_failed',
          `Build failed: ${name}`,
          `${name} failed on ${where}${w.head_branch ? ` (${str(w.head_branch, 60)})` : ''}`,
          w.html_url,
          'high',
          w.updated_at,
        ),
      ]
    }
    return []
  }

  if (ev === 'pull_request' && issue) {
    const title = str(issue.title, 200)
    const num = typeof issue.number === 'number' ? ` (#${issue.number})` : ''
    if (action === 'review_requested' && me && loginOf(p.requested_reviewer).toLowerCase() === me)
      return [
        mk(
          'github.review_requested',
          `Review requested: ${title}${num}`,
          `${loginOf(sender) || 'Someone'} requested your review on ${where}${num}: ${title}`,
          issue.html_url,
          'high',
          issue.updated_at,
        ),
      ]
    if (action === 'assigned' && me && loginOf(p.assignee).toLowerCase() === me)
      return [
        mk(
          'github.assign',
          title,
          `${loginOf(sender) || 'Someone'} assigned you to ${where}${num}: ${title}`,
          issue.html_url,
          'high',
          issue.updated_at,
        ),
      ]
    if ((action === 'opened' || action === 'edited') && mentions(issue.body, me))
      return [
        mk(
          'github.mention',
          title,
          `${loginOf(sender) || 'Someone'} mentioned you in ${where}${num}: ${title}`,
          issue.html_url,
          'high',
          issue.updated_at,
        ),
      ]
    if (['opened', 'closed', 'reopened', 'ready_for_review'].includes(action))
      return [
        mk(
          'github.event',
          title,
          `Pull request ${action === 'closed' && issue.merged === true ? 'merged' : action} in ${where}${num}: ${title}`,
          issue.html_url,
          'low',
          issue.updated_at,
        ),
      ]
    return []
  }

  if (ev === 'issues' && issue) {
    const title = str(issue.title, 200)
    const num = typeof issue.number === 'number' ? ` (#${issue.number})` : ''
    if (action === 'assigned' && me && loginOf(p.assignee).toLowerCase() === me)
      return [
        mk(
          'github.assign',
          title,
          `${loginOf(sender) || 'Someone'} assigned you to ${where}${num}: ${title}`,
          issue.html_url,
          'high',
          issue.updated_at,
        ),
      ]
    if ((action === 'opened' || action === 'edited') && mentions(issue.body, me))
      return [
        mk(
          'github.mention',
          title,
          `${loginOf(sender) || 'Someone'} mentioned you in ${where}${num}: ${title}`,
          issue.html_url,
          'high',
          issue.updated_at,
        ),
      ]
    if (action === 'opened')
      return [
        mk('github.event', title, `Issue opened in ${where}${num}: ${title}`, issue.html_url, 'low', issue.updated_at),
      ]
    return []
  }

  if (
    (ev === 'issue_comment' || ev === 'pull_request_review_comment' || ev === 'pull_request_review') &&
    action !== 'deleted'
  ) {
    const c = isRecord(p.comment) ? p.comment : isRecord(p.review) ? p.review : undefined
    const subject = issue ?? (isRecord(p.pull_request) ? p.pull_request : undefined)
    if (!c || !subject) return []
    if (me && loginOf(c.user).toLowerCase() === me) return [] // the owner's own comment
    const title = str(subject.title, 200)
    if (mentions(c.body, me))
      return [
        mk(
          'github.mention',
          title,
          `${loginOf(c.user) || 'Someone'} mentioned you in ${where}: ${str(c.body, 200)}`,
          c.html_url ?? subject.html_url,
          'high',
          c.updated_at ?? c.submitted_at,
        ),
      ]
    if (ev === 'issue_comment' || ev === 'pull_request_review_comment' || action === 'submitted')
      return [
        mk(
          'github.event',
          title,
          `${loginOf(c.user) || 'Someone'} commented on ${where}: ${str(c.body, 200)}`,
          c.html_url ?? subject.html_url,
          'low',
          c.updated_at ?? c.submitted_at,
        ),
      ]
  }
  return []
}

// ---- creating the webhooks with a fine-grained token (Webhooks: read and write) ----------------------------------------

export const GITHUB_HOOK_EVENTS = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
]

export type CreateHookResult = { repo: string; ok: boolean; hookId?: number; error?: string }

/**
 * Creates one webhook per repo (`POST /repos/{owner}/{repo}/hooks`). The token is used for these calls only; the caller
 * discards it afterwards unless the owner ticked auto-repair. Never throws; errors carry no token text.
 */
export async function createRepoWebhooks(args: {
  fetch: typeof fetch
  token: string
  repos: string[]
  hookUrl: string
  secret: string
}): Promise<CreateHookResult[]> {
  const out: CreateHookResult[] = []
  for (const repo of args.repos) {
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo) || repo.includes('..')) {
      out.push({ repo, ok: false, error: 'bad_repo_name' })
      continue
    }
    try {
      const res = await args.fetch(`https://api.github.com/repos/${repo}/hooks`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${args.token}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'talos-app-github/1',
        },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: GITHUB_HOOK_EVENTS,
          config: { url: args.hookUrl, content_type: 'json', secret: args.secret, insecure_ssl: '0' },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 201) {
        const j: unknown = await res.json().catch(() => undefined)
        out.push({ repo, ok: true, ...(isRecord(j) && typeof j.id === 'number' ? { hookId: j.id } : {}) })
      } else out.push({ repo, ok: false, error: `github_${res.status}` })
    } catch {
      out.push({ repo, ok: false, error: 'network_error' })
    }
  }
  return out
}
