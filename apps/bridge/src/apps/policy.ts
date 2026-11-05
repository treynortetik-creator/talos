// Authorising an app's tool call (M4.3) and the rate limits (M4.6). `decideCall` runs steps 2 to 8 in order; the first
// failure answers `app.response failed`. Step 1 (signature, freshness, replay) is the inbound pipeline's.
import type { AppErrorCodeT, CatalogToolT } from '@talos-app/protocol'
import {
  type AppCatalogT,
  type CatalogResourceT,
  type CatalogServerT,
  findServer,
  toolRunsWithoutTap,
} from './catalog.ts'
import type { LabelCheck } from './direct.ts'
import type { AppStore, ViewRow } from './views.ts'

const MIN = 60_000
const HOUR = 3600_000
const DAY = 24 * HOUR

/** Sliding windows over timestamps. A clock that jumps back keeps the future-dated hits (conservative); forward drops them. */
export class Limits {
  private hits = new Map<string, number[]>()
  constructor(private readonly now: () => number) {}

  private live(key: string, windowMs: number): number[] {
    const t = this.now()
    const l = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs)
    this.hits.set(key, l)
    return l
  }

  count(key: string, windowMs: number): number {
    return this.live(key, windowMs).length
  }

  /** Checks every window first, records only if all pass (a refused call spends nothing). Returns the first limit hit. */
  take(takes: Array<[key: string, windowMs: number, max: number]>): { ok: true } | { ok: false; key: string } {
    for (const [key, w, max] of takes) if (this.live(key, w).length >= max) return { ok: false, key }
    const t = this.now()
    for (const [key, w] of takes) this.live(key, w).push(t)
    return { ok: true }
  }

  /** A limit hit by a view; true when the third in 10 minutes means the view must be closed (M4.6 abuse rule). */
  noteHit(viewId: string): boolean {
    const l = this.live(`abuse:${viewId}`, 10 * MIN)
    l.push(this.now())
    return l.length >= 3
  }

  forgetView(viewId: string): void {
    for (const k of [...this.hits.keys()]) if (k.includes(viewId)) this.hits.delete(k)
  }
}

export type CallReq = {
  viewId: string
  threadId: string
  toolName: string
  gesture: boolean
  argsBytes: number
}

export type Decision =
  | {
      kind: 'fail'
      code: AppErrorCodeT
      message: string
      /** The view's catalog entry no longer matches: revoke the server's views (steps 3 and the label check). */
      revoke?: 'server'
      /** Mark the catalog resource needs_reapproval with this diff. */
      reapproval?: string
      closeView?: boolean
    }
  | {
      kind: 'run'
      path: 'agent' | 'direct'
      card: boolean
      /** Why a card, when it is one; shown in the card's warning. */
      couldntCheck?: boolean
      server: CatalogServerT
      tool: CatalogToolT
      resource: CatalogResourceT
      view: ViewRow
    }

const fail = (
  code: AppErrorCodeT,
  message: string,
  extra: Partial<Extract<Decision, { kind: 'fail' }>> = {},
): Decision => ({
  kind: 'fail',
  code,
  message,
  ...extra,
})

export type DecideCtx = {
  now: number
  catalog: AppCatalogT | undefined
  store: AppStore
  limits: Limits
  /** Open requests of the view (pending or running). */
  pendingCount: (viewId: string) => number
  /** The call-time label check for a no-card call on a server with a label-check connection. */
  labelCheck: (server: CatalogServerT, tool: CatalogToolT) => Promise<LabelCheck>
  /** Does this server have a label-check connection (http/sse, owner.direct)? */
  hasLabelConnection: (server: CatalogServerT, resource: CatalogResourceT) => boolean
  /**
   * Trust mode (docs/SECURITY.md) does not change an app's calls: every write draws a card, trust mode or not, because a
   * tap inside a view cannot be told from the view acting alone. Approval-key and label checks still run first.
   */
  trust?: boolean
}

export async function decideCall(c: DecideCtx, r: CallReq): Promise<Decision> {
  // 2. the view
  const view = c.store.getView(r.viewId)
  if (!view || view.thread_id !== r.threadId) return fail('view_unknown', 'That view is not known here.')
  if (view.state !== 'active' || c.now >= Date.parse(view.calls_until))
    return fail('view_closed', 'That view is closed.')
  // 3. the approval key still matches the catalog
  const server = c.catalog ? findServer(c.catalog, view.server, view.source) : undefined
  const resource = server?.resources.find((x) => x.uri === view.resource_uri)
  if (!server || !resource || resource.state !== 'approved' || resource.approval_key !== view.approval_key)
    return fail('approval_changed', 'This app changed since it was approved. Run talos-app apps scan on the Mac.', {
      revoke: 'server',
    })
  // 5 (looked up early so the direct path knows its budget): tool of this server, or another catalogued server's
  const tool = server.tools.find((t) => t.name === r.toolName)
  const direct = !!tool && tool.visibility.length === 1 && tool.visibility[0] === 'app'
  // 4. limits and budgets
  const V = r.viewId
  const takes: Array<[string, number, number]> = direct
    ? [
        [`v:${V}:dcall:m`, MIN, 60],
        [`v:${V}:dcall:d`, DAY, 2000],
        ['g:dcall:m', MIN, 300],
      ]
    : [
        [`v:${V}:call:m`, MIN, 30],
        [`v:${V}:call:d`, DAY, 60],
        ['g:call:m', MIN, 120],
        ['g:call:d', DAY, 300],
        [`s:${server.server}\u0000${server.source}:call:m`, MIN, 60],
      ]
  if (!direct && !r.gesture) takes.push([`v:${V}:nogesture:m`, MIN, 6])
  const took = c.limits.take(takes)
  if (!took.ok) {
    const close = c.limits.noteHit(V)
    return fail('rate_limited', 'Too many requests. Slow down.', close ? { closeView: true } : {})
  }
  if (c.pendingCount(V) >= 3) return fail('too_many_pending', 'Three requests from this app are already waiting.')
  // 5. tool lookup
  if (!tool) {
    const other = c.catalog?.servers.find((s) => s !== server && s.tools.some((t) => t.name === r.toolName))
    return other
      ? fail('cross_server', 'That tool belongs to another server.')
      : fail('not_in_catalog', 'That tool is not part of this app.')
  }
  // 6. visibility
  if (!tool.visibility.includes('app')) return fail('not_app_visible', 'That tool is not available to apps.')
  if (direct) {
    const t = server.direct?.type
    if (!((t === 'http' || t === 'sse') && resource.owner.direct))
      return fail('app_only_unsupported', "This app's app-only buttons don't work with this kind of server.")
  }
  // 7. size is enforced by the frame schema; re-check
  if (r.argsBytes > 16 * 1024) return fail('too_large', 'The request is too large.')
  // 8. decide
  const base = { path: direct ? ('direct' as const) : ('agent' as const), server, tool, resource, view }
  // An app's write always gets its card, trust mode or not: the view's own tap cannot be told from the view acting alone
  // (user_gesture is only a hint), so nothing a view starts is sent or changed on its say-so.
  const needsCard = !toolRunsWithoutTap(server, tool)
  if (needsCard) return { kind: 'run', card: true, ...base }
  if (c.hasLabelConnection(server, resource)) {
    const check = await c.labelCheck(server, tool)
    if (check === 'changed')
      return fail('approval_changed', 'This app changed how it labels its tools.', {
        revoke: 'server',
        reapproval: `\`${tool.name}\` is labelled differently than when you approved it`,
      })
    if (check === 'failed') return { kind: 'run', card: true, couldntCheck: true, ...base }
    return { kind: 'run', card: false, ...base }
  }
  // no label-check connection: the approved labels decide, unless strict
  if (c.catalog?.strict) return { kind: 'run', card: true, couldntCheck: true, ...base }
  return { kind: 'run', card: false, ...base }
}

/** `ui/message` limits (M4.6): per view 6/min and 30/day, global 30/hour. */
export function takeMessage(l: Limits, viewId: string): { ok: true } | { ok: false } {
  const r = l.take([
    [`v:${viewId}:msg:m`, MIN, 6],
    [`v:${viewId}:msg:d`, DAY, 30],
    ['g:msg:h', HOUR, 30],
  ])
  return r.ok ? { ok: true } : { ok: false }
}
