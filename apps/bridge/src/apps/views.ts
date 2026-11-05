// App views on the Mac (M5.5): the `app_views` / `app_requests` tables, minting a view row, and the relay upload of a
// pinned page. A view is a bridge-minted `reply` of kind 'app'; the relay accepts that kind only from the bridge.
import { join } from 'node:path'
import {
  APP_CSP_HEADER,
  APP_TOOL_RESULT_MAX,
  APP_TOOL_RESULT_MEDIA_MAX,
  type AppCspT,
  type AppErrorCodeT,
  type AppViewT,
  type AttachmentRefT,
  encodeAppCspHeader,
  jcsBytes,
  type McpCallToolResultT,
  type MessageT,
  newId,
  newUlid,
  sha256Hex,
} from '@talos-app/protocol'
import { iso } from '../clock.ts'
import type { BridgeContext } from '../context.ts'
import { writeFileAtomic } from '../fsutil.ts'
import type { HistoryStore } from '../history-store.ts'

export const VIEW_CALL_WINDOW_MS = 24 * 3600_000

export type ViewState = 'active' | 'superseded' | 'closed' | 'revoked'
export type ViewRow = {
  view_id: string
  thread_id: string
  server: string
  source: string
  tool: string
  resource_uri: string
  approval_key: string
  shown_at: string
  calls_until: string
  state: ViewState
}
export type RequestRow = {
  request_id: string
  view_id: string
  method: string
  created_at: string
  state: string
  card_id: string | null
  tool_use_id: string | null
  resolved_at: string | null
}

export class AppStore {
  constructor(private readonly store: HistoryStore) {}

  newViewId(): string {
    return `av_${newUlid()}`
  }

  addView(v: ViewRow): void {
    this.store.db
      .query(
        'INSERT INTO app_views (view_id, thread_id, server, source, tool, resource_uri, approval_key, shown_at, calls_until, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        v.view_id,
        v.thread_id,
        v.server,
        v.source,
        v.tool,
        v.resource_uri,
        v.approval_key,
        v.shown_at,
        v.calls_until,
        v.state,
      )
  }

  getView(id: string): ViewRow | undefined {
    return (this.store.db.query('SELECT * FROM app_views WHERE view_id = ?').get(id) as ViewRow | null) ?? undefined
  }

  /** Active views, optionally narrowed. */
  activeViews(f: { thread_id?: string; server?: string; source?: string; resource_uri?: string } = {}): ViewRow[] {
    const rows = this.store.db.query("SELECT * FROM app_views WHERE state = 'active'").all() as ViewRow[]
    return rows.filter(
      (r) =>
        (f.thread_id === undefined || r.thread_id === f.thread_id) &&
        (f.server === undefined || r.server === f.server) &&
        (f.source === undefined || r.source === f.source) &&
        (f.resource_uri === undefined || r.resource_uri === f.resource_uri),
    )
  }

  /** active -> `to`, once. False when the view was not active (someone else got there first). */
  setViewState(id: string, to: Exclude<ViewState, 'active'>): boolean {
    return (
      this.store.db.query("UPDATE app_views SET state = ? WHERE view_id = ? AND state = 'active'").run(to, id)
        .changes === 1
    )
  }

  addRequest(r: Pick<RequestRow, 'request_id' | 'view_id' | 'method' | 'created_at' | 'state'>): void {
    this.store.db
      .query(
        'INSERT OR IGNORE INTO app_requests (request_id, view_id, method, created_at, state) VALUES (?, ?, ?, ?, ?)',
      )
      .run(r.request_id, r.view_id, r.method, r.created_at, r.state)
  }

  getRequest(id: string): RequestRow | undefined {
    return (
      (this.store.db.query('SELECT * FROM app_requests WHERE request_id = ?').get(id) as RequestRow | null) ?? undefined
    )
  }

  updateRequest(
    id: string,
    patch: { state?: string; card_id?: string; tool_use_id?: string; resolved_at?: string },
  ): void {
    const cur = this.getRequest(id)
    if (!cur) return
    this.store.db
      .query('UPDATE app_requests SET state = ?, card_id = ?, tool_use_id = ?, resolved_at = ? WHERE request_id = ?')
      .run(
        patch.state ?? cur.state,
        patch.card_id ?? cur.card_id,
        patch.tool_use_id ?? cur.tool_use_id,
        patch.resolved_at ?? cur.resolved_at,
        id,
      )
  }

  /** Requests of a view still waiting on a card or a result. */
  openRequests(viewId: string): RequestRow[] {
    return this.store.db
      .query("SELECT * FROM app_requests WHERE view_id = ? AND state IN ('authorised', 'awaiting_card', 'running')")
      .all(viewId) as RequestRow[]
  }

  allOpenRequests(): RequestRow[] {
    return this.store.db
      .query("SELECT * FROM app_requests WHERE state IN ('authorised', 'awaiting_card', 'running')")
      .all() as RequestRow[]
  }

  /** Old rows only; open requests and active views are never cut. */
  prune(nowMs: number, keepMs = 7 * 24 * 3600_000): void {
    const cut = iso(nowMs - keepMs)
    this.store.db
      .query(
        "DELETE FROM app_requests WHERE created_at < ? AND state NOT IN ('authorised', 'awaiting_card', 'running')",
      )
      .run(cut)
    this.store.db.query("DELETE FROM app_views WHERE calls_until < ? AND state <> 'active'").run(cut)
  }
}

// ---- pages and results on the relay -----------------------------------------------------------------------------------

export type PageRef = { ref: AttachmentRefT; header: string }

/**
 * Uploads the pinned HTML with its CSP header. The media id is reused per approval key while the relay still has it
 * (`kv` remembers it; a re-upload of the same bytes is the rehydrate path). The local index lets `media.fetch` re-upload
 * with the same header after the relay's buffer expires.
 */
export async function uploadAppPage(
  ctx: BridgeContext,
  a: { html: Uint8Array; csp: AppCspT; approvalKey: string; name: string },
): Promise<PageRef> {
  const header = encodeAppCspHeader(a.csp)
  const sha = sha256Hex(a.html)
  const kvKey = `app_page:${a.approvalKey}`
  const prev = ctx.store.kvGet(kvKey)
  let id: string | undefined
  if (prev) {
    try {
      const p = JSON.parse(prev) as { media_id?: string; sha256?: string; at?: number }
      // the relay keeps media 7 days; reuse under 6 so a view never points at a page the relay already dropped
      if (p.media_id && p.sha256 === sha && typeof p.at === 'number' && ctx.clock.now() - p.at < 6 * 24 * 3600_000)
        id = p.media_id
    } catch {
      // fall through to a fresh upload
    }
  }
  const fresh = id === undefined
  const mediaId = id ?? newId('md')
  await ctx.http.putMedia(mediaId, a.html, sha, 'text/html', a.name, { [APP_CSP_HEADER]: header })
  if (fresh) ctx.store.kvSet(kvKey, JSON.stringify({ media_id: mediaId, sha256: sha, at: ctx.clock.now() }))
  const ref: AttachmentRefT = {
    media_id: mediaId,
    kind: 'html',
    role: 'attachment',
    mime: 'text/html',
    name: a.name.slice(0, 200),
    size: a.html.length,
    sha256: sha,
  }
  return { ref, header }
}

/** Keeps the local media index so `media.fetch` can re-upload the page with its CSP header. */
export function writeAppMediaIndex(ctx: BridgeContext, p: PageRef, htmlPath: string): void {
  writeFileAtomic(
    join(ctx.paths.media, `${p.ref.media_id}.json`),
    JSON.stringify({ path: htmlPath, ref: p.ref, headers: { [APP_CSP_HEADER]: p.header } }),
    0o600,
  )
}

/**
 * A tool result for the view: inline up to 128 KiB (JCS), else JSON media up to 8 MiB, uploaded straight to the relay.
 * It is NEVER written to the Mac's media cache, so a direct-path result leaves no copy there (M5.6).
 */
export async function packResult(
  ctx: BridgeContext,
  result: McpCallToolResultT,
): Promise<{ result: McpCallToolResultT } | { media: AttachmentRefT } | { error: AppErrorCodeT }> {
  const n = jcsBytes(result)
  if (n === undefined) return { error: 'tool_failed' }
  if (n <= APP_TOOL_RESULT_MAX) return { result }
  if (n > APP_TOOL_RESULT_MEDIA_MAX) return { error: 'too_large' }
  const bytes = new TextEncoder().encode(JSON.stringify(result))
  const id = newId('md')
  const sha = sha256Hex(bytes)
  await ctx.http.putMedia(id, bytes, sha, 'application/json', 'result.json')
  return {
    media: {
      media_id: id,
      kind: 'file',
      role: 'attachment',
      mime: 'application/json',
      name: 'result.json',
      size: bytes.length,
      sha256: sha,
    },
  }
}

export function viewMessage(ctx: BridgeContext, view: AppViewT): MessageT {
  return {
    id: newId('m'),
    thread_id: view.thread_id,
    author: 'app',
    kind: 'app',
    attachments: [],
    format: 'plain',
    via: 'app',
    created_at: iso(ctx.clock.now()),
    app: view,
  } as MessageT
}
