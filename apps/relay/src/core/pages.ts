// Org pages, phase 1 (docs/ORG-PAGES-SPEC.md, "Owner decisions" last): the routes. The bridge publishes a thread's HTML,
// signed with its key; the store (core/pages-store.ts) keeps it versioned past the 7-day media buffer, under the relay-wide
// caps (PAGES_MAX_MB, PAGES_MAX: 507 pages_full). The page is served to the owner's own logged-in devices only, under the
// page policy every agent page runs in (PAGE_CSP: sandboxed, opaque origin, no network). A share (scope, who, until when) is
// stored and ended by the sweeper, but no one else can open a page before viewer sign-in (phase 3). The agent never shares:
// share, unshare, restore and delete are owner frames signed by the device key, fresh and single use, as bug reports are.
import {
  APNS_REGISTRATION_SKEW_MS,
  appCsp,
  PAGE_CSP,
  PAGE_LIMITS,
  PAGE_SANDBOX_ATTR,
  PAGES_FULL,
  PageHash,
  PageId,
  type PageInfoT,
  PageOwnerAction,
  type PageOwnerActionT,
  PagePublishQuery,
  ThreadId,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { getSession, requireCsrf, requireSession } from '../auth/contract.ts'
import type { AppEnv } from '../services.ts'
import { bodyTimeout, idleBodyTimeout, lateRequest, limitBody, readBodyWithDeadline } from './body-guard.ts'
import { bridgeAuth } from './index.ts'
import { type Deps, deletePage, pageInfo, pageRow, pagesBytes, publishPage, readVersion } from './pages-store.ts'

const DAY_MS = 86_400_000
/** An owner action is a small signed object; anything bigger is not one. */
const ACTION_MAX_BYTES = 64 * 1024
/** Every /p response that is not the page itself (401, 404) is never rendered as a page. */
const ERROR_CSP = "sandbox; default-src 'none'"

// ---- routes -----------------------------------------------------------------------------------------------------------

export const pageRoutes = new Hono<AppEnv>()

const deps = (c: Context<AppEnv>): Deps => {
  const s = c.get('services')
  return { db: s.db, crypto: s.crypto, clock: s.clock, dataDir: s.env.DATA_DIR }
}
/** Missing, malformed, another thread's or not kept: one answer, so none can be told from the others. */
const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })

pageRoutes.use('/p/*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Content-Security-Policy')) c.res.headers.set('Content-Security-Policy', ERROR_CSP)
})

// The bridge publishes (create, or a new version). The query is part of the signed path, so the thread and title are the Mac's.
// /bridge/* reads the whole body before it can verify the signature: a fixed deadline, never an idle one (the bridge's own
// upload deadline for 10 MiB is 15 s + 2 s per MB).
const publishBodyGuard = [limitBody(() => PAGE_LIMITS.versionBytes), bodyTimeout(40_000)] as const

pageRoutes.post('/bridge/pages', ...publishBodyGuard, async (c) => {
  const auth = await bridgeAuth(c, PAGE_LIMITS.versionBytes)
  if (auth instanceof Response) return auth
  // the deadline passed while the body was read or the signature checked: the bridge was told 408, so nothing is stored
  if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
  const url = new URL(c.req.url)
  const parsed = PagePublishQuery.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success || url.searchParams.getAll('title').length !== 1) return c.json({ error: 'bad_request' }, 400)
  const html = auth.body
  if (html.length === 0) return c.json({ error: 'bad_html' }, 400)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(html)
  } catch {
    return c.json({ error: 'bad_html' }, 400)
  }
  const env = c.get('services').env
  const out = publishPage(deps(c), parsed.data, html, {
    maxBytes: env.PAGES_MAX_MB * 1024 * 1024,
    maxPages: env.PAGES_MAX,
  })
  if (out.kind === 'not_found') return notFound(c)
  if (out.kind === 'full') return c.json(PAGES_FULL, 507)
  return c.json(
    {
      page_id: out.page_id,
      version: out.version,
      unchanged: out.unchanged,
      owner_url: `${env.PUBLIC_ORIGIN}/p/${out.page_id}`,
    },
    out.status,
  )
})

pageRoutes.get('/api/pages', requireSession, (c) => {
  const s = c.get('services')
  // ?thread=<id>: one thread's pages only (a thread's Pages pane); none = every page
  const thread = c.req.query('thread')
  if (thread !== undefined && !ThreadId.safeParse(thread).success) return c.json({ error: 'bad_request' }, 400)
  const ids = (
    thread === undefined
      ? s.db.prepare('select page_id from core_pages order by updated_at desc, page_id desc').all()
      : s.db
          .prepare('select page_id from core_pages where thread_id = ? order by updated_at desc, page_id desc')
          .all(thread)
  ) as { page_id: string }[]
  return c.json({
    pages: ids.map((r) => pageInfo(s.db, r.page_id)).filter((p): p is PageInfoT => p !== null),
    used_bytes: pagesBytes(s),
    max_bytes: s.env.PAGES_MAX_MB * 1024 * 1024,
    max_pages: s.env.PAGES_MAX,
  })
})

pageRoutes.get('/api/pages/:id', requireSession, (c) => {
  const id = c.req.param('id')
  const info = PageId.safeParse(id).success ? pageInfo(c.get('services').db, id) : null
  return info ? c.json(info) : notFound(c)
})

type ActionType = PageOwnerActionT['type']

/**
 * A device-signed owner change, checked as the bug-report route checks its report: the session's own pinned, un-revoked
 * device signed it, it is fresh, it names the page in the path and an action this route takes, and its nonce is used once.
 */
async function ownerAction(c: Context<AppEnv>, want: ActionType): Promise<PageOwnerActionT | Response> {
  const services = c.get('services')
  const read = await readBodyWithDeadline(c, ACTION_MAX_BYTES)
  if (lateRequest(c) || (!read.ok && read.why === 'timeout')) return c.json({ error: 'request_timeout' }, 408)
  if (!read.ok) return c.json({ error: 'too_large' }, 413)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(read.body))
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }
  const parsed = PageOwnerAction.safeParse(raw)
  if (!parsed.success || parsed.data.type !== want || parsed.data.page_id !== c.req.param('id'))
    return c.json({ error: 'bad_request' }, 400)
  const a = parsed.data
  const session = getSession(c)
  if (!session?.deviceId || session.deviceId !== a.device_id) return c.json({ error: 'wrong_device' }, 403)
  const row = services.db
    .prepare('select pubkey_jwk from auth_devices where id = ? and pinned = 1 and revoked = 0')
    .get(a.device_id) as { pubkey_jwk: string } | undefined
  let jwk: unknown = null
  try {
    jwk = row ? JSON.parse(row.pubkey_jwk) : null
  } catch {
    jwk = null
  }
  if (!row || jwk === null || typeof jwk !== 'object') return c.json({ error: 'bad_signature' }, 401)
  if (!(await verifyOwnerFrame(raw as Record<string, unknown>, jwk as never)))
    return c.json({ error: 'bad_signature' }, 401)
  const now = services.clock.now()
  if (Math.abs(Date.parse(a.ts) - now) > APNS_REGISTRATION_SKEW_MS) return c.json({ error: 'stale' }, 400)
  if (!pageRow(services.db, a.page_id)) return notFound(c)
  const burned = services.db.transaction(() => {
    services.db.prepare('delete from core_push_nonces where expires_at <= ?').run(now)
    return services.db
      .prepare('insert or ignore into core_push_nonces (nonce_key, expires_at) values (?, ?)')
      .run(`page:${a.device_id}:${a.nonce}`, now + 2 * APNS_REGISTRATION_SKEW_MS).changes
  })()
  if (burned === 0) return c.json({ error: 'replay' }, 409)
  return a
}

const actionGuard = [
  limitBody(() => ACTION_MAX_BYTES),
  idleBodyTimeout(undefined, undefined, { stopWhenBodyIn: true }),
  requireSession,
  requireCsrf,
] as const

pageRoutes.post('/api/pages/:id/share', ...actionGuard, async (c) => {
  const a = await ownerAction(c, 'page.share')
  if (a instanceof Response) return a
  if (a.type !== 'page.share') return c.json({ error: 'bad_request' }, 400)
  const s = c.get('services')
  const now = s.clock.now()
  const expires =
    a.expires_at === undefined
      ? now + PAGE_LIMITS.shareDefaultDays * DAY_MS
      : a.expires_at === null
        ? null
        : Date.parse(a.expires_at)
  if (expires !== null && expires <= now) return c.json({ error: 'bad_request' }, 400)
  s.db
    .prepare(
      'insert into core_page_shares (page_id, scope, emails, shared_at, expires_at) values (?, ?, ?, ?, ?) on conflict (page_id) do update set scope = excluded.scope, emails = excluded.emails, shared_at = excluded.shared_at, expires_at = excluded.expires_at',
    )
    .run(a.page_id, a.scope, JSON.stringify(a.scope === 'org' ? [] : a.emails), now, expires)
  return c.json(pageInfo(s.db, a.page_id))
})

pageRoutes.post('/api/pages/:id/unshare', ...actionGuard, async (c) => {
  const a = await ownerAction(c, 'page.unshare')
  if (a instanceof Response) return a
  const s = c.get('services')
  s.db.prepare('delete from core_page_shares where page_id = ?').run(a.page_id)
  return c.json(pageInfo(s.db, a.page_id))
})

pageRoutes.post('/api/pages/:id/current', ...actionGuard, async (c) => {
  const a = await ownerAction(c, 'page.current')
  if (a instanceof Response) return a
  if (a.type !== 'page.current') return c.json({ error: 'bad_request' }, 400)
  const s = c.get('services')
  const kept = s.db.prepare('select 1 from core_page_versions where page_id = ? and hash = ?').get(a.page_id, a.hash)
  if (!kept) return notFound(c)
  s.db
    .prepare('update core_pages set current_hash = ?, updated_at = ? where page_id = ?')
    .run(a.hash, s.clock.now(), a.page_id)
  return c.json(pageInfo(s.db, a.page_id))
})

pageRoutes.delete('/api/pages/:id', ...actionGuard, async (c) => {
  const a = await ownerAction(c, 'page.delete')
  if (a instanceof Response) return a
  deletePage(deps(c), a.page_id)
  return c.body(null, 204)
})

const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)

// The page's link: a small trusted page under the app's own policy that frames the page. Its `frame-src 'self'` is what
// stops the page from navigating itself to another site (PAGE_CSP cannot); it holds no script and no owner data. Phase 1:
// the owner's session only (the viewer shell, its banner and sign-in are phase 3).
pageRoutes.get('/p/:id', requireSession, (c) => {
  const id = c.req.param('id')
  const p = PageId.safeParse(id).success ? pageRow(c.get('services').db, id) : undefined
  if (!p) return notFound(c)
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(p.title)}</title></head><body style="margin:0"><iframe src="/p/${id}/frame" sandbox="${PAGE_SANDBOX_ATTR}" referrerpolicy="no-referrer" title="${escapeHtml(p.title)}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe></body></html>`
  return c.body(html, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': appCsp(c.get('services').env.PUBLIC_ORIGIN),
    'Cache-Control': 'private, no-store',
  })
})

// The page bytes, under the page policy: sandboxed, opaque origin, no network. The current version, or ?v=<a kept hash>.
pageRoutes.get('/p/:id/frame', requireSession, (c) => {
  const id = c.req.param('id')
  const d = deps(c)
  // only ever inside a frame (the link's wrapper, the app's SandboxedFrame): at the top it could navigate itself anywhere
  if (c.req.header('sec-fetch-dest') === 'document') return notFound(c)
  if (!PageId.safeParse(id).success) return notFound(c)
  const p = pageRow(d.db, id)
  const v = c.req.query('v')
  const hash = v === undefined ? p?.current_hash : PageHash.safeParse(v).success ? v : undefined
  const bytes = p && hash ? readVersion(d, id, hash) : null
  if (!bytes) return notFound(c)
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    },
  })
})
