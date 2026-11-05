// Share to Talos, relay side (docs/V2-FEATURES.md V4.3-V4.5, V4.7). Owns the share-token table and the two route groups:
//   - /api/share/tokens   (session + CSRF; POST binds the session's pinned device)
//   - POST /api/share     (the token's one route: `Authorization: Bearer talos_share_<43>`)
// A token can put an Inbox message in front of the owner and nothing else: no thread choice, no reads, no other route.
// The row it lands is built HERE (author owner, via share, thread inbox), stored and sent to the apps like
// `message.stored`, and sent to the Mac as the consumable `share.item`. The bridge wraps it as untrusted (V4.7).
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import {
  type AttachmentRefT,
  b64urlEncode,
  DeviceId,
  HttpsUrl,
  newId,
  newUlid,
  SHARE_FEATURE,
  SHARE_LIMITS,
  SHARE_SECRET_RE,
  SHARE_THREAD,
  type ShareContentT,
  SharePostBody,
  ShareScope,
  type ShareScopeT,
  type ShareTokenT,
  shareHasContent,
} from '@talos-app/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { getSession, preflightBridgeHttp, requireCsrf, requireSession, verifyBridgeHttp } from '../auth/contract.ts'
import { RateLimiter } from '../auth/limits.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { idleBodyTimeout, lateRequest, limitBody, originalRequest } from './body-guard.ts'
import { registerRelayFeature } from './features.ts'
import { runtimeOf } from './runtime.ts'
import { clientIp, DAY_MS } from './util.ts'

const MIB = 1024 * 1024
/** A text-only token never needs more than text 32k + note 4k + url + title in one request. */
const TEXT_BODY_CAP = 128 * 1024
const FILES_BODY_CAP = SHARE_LIMITS.files * SHARE_LIMITS.fileBytes + MIB

type Row = {
  id: string
  label: string
  device_id: string
  scopes: string
  created_at: number
  last_used_at: number | null
  last_used_net: string | null
  revoked_at: number | null
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

function toToken(r: Row): ShareTokenT {
  return {
    id: r.id,
    label: r.label,
    device_id: r.device_id,
    scopes: JSON.parse(r.scopes) as ShareScopeT[],
    created_at: iso(r.created_at) as string,
    last_used_at: iso(r.last_used_at),
    last_used_net: r.last_used_net,
    revoked_at: iso(r.revoked_at),
  }
}

/** A live token: not revoked, and its device still pinned and not revoked. Dead rows neither count nor list. */
const LIVE =
  't.revoked_at is null and exists (select 1 from auth_devices d where d.id = t.device_id and d.pinned = 1 and d.revoked = 0)'

/** Bytes shares uploaded since `since` (ms). Their own budget; the owner's media budget subtracts them. */
export function shareBytesSince(db: RelayServices['db'], since: number): number {
  return (
    db.prepare('select coalesce(sum(size), 0) s from core_share_uploads where created_at >= ?').get(since) as {
      s: number
    }
  ).s
}
const SHARE_DAILY_BYTES = 200 * MIB

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

/** IPv4 /24 or IPv6 /48, so use from a stranger's network shows up without storing an address. */
export function networkOf(ip: string): string | null {
  const v4 = (s: string) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(s)
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null
  }
  const direct = v4(ip)
  if (direct) return direct
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip)
  if (mapped) return v4(mapped[1] as string)
  if (!ip.includes(':')) return null
  const [head = '', tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return `${groups
    .slice(0, 3)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/48`
}

export class ShareStore {
  constructor(private services: RelayServices) {}
  private get db() {
    return this.services.db
  }

  /** Pinned, not revoked: the same test the Mac's own device list uses. */
  deviceOk(deviceId: string): boolean {
    return Boolean(
      this.db.prepare('select 1 from auth_devices where id = ? and pinned = 1 and revoked = 0').get(deviceId),
    )
  }

  activeCount(): number {
    return (this.db.prepare(`select count(*) n from core_share_tokens t where ${LIVE}`).get() as { n: number }).n
  }

  create(a: { label: string; scopes: ShareScopeT[]; deviceId: string }): { token: ShareTokenT; secret: string } {
    const id = newId('sh')
    const secret = `talos_share_${b64urlEncode(randomBytes(32))}`
    this.db
      .prepare(
        'insert into core_share_tokens (id, label, device_id, scopes, secret_hash, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(id, a.label, a.deviceId, JSON.stringify(a.scopes), hashSecret(secret), this.services.clock.now())
    return { token: toToken(this.row(id) as Row), secret }
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('select * from core_share_tokens where id = ?').get(id) as Row | undefined
  }

  list(): ShareTokenT[] {
    const rows = this.db
      .prepare(`select * from core_share_tokens t where ${LIVE} order by created_at, id`)
      .all() as Row[]
    return rows.map(toToken)
  }

  revoke(id: string): boolean {
    return (
      this.db
        .prepare('update core_share_tokens set revoked_at = ? where id = ? and revoked_at is null')
        .run(this.services.clock.now(), id).changes > 0
    )
  }

  /** True when the id names a token at all, live or already revoked (the bridge revoke is idempotent on these). */
  exists(id: string): boolean {
    return Boolean(this.row(id))
  }

  /** The live token for a secret: not revoked, and its device pinned and not revoked (the join). */
  lookup(secret: string): ShareTokenT | null {
    const r = this.db
      .prepare(
        `select t.* from core_share_tokens t join auth_devices d on d.id = t.device_id
         where t.secret_hash = ? and t.revoked_at is null and d.pinned = 1 and d.revoked = 0`,
      )
      .get(hashSecret(secret)) as Row | undefined
    return r ? toToken(r) : null
  }

  /** Re-check at commit time: the token and its device are still live (a revoke can land while the body uploads). */
  stillValid(id: string): boolean {
    return Boolean(this.db.prepare(`select 1 from core_share_tokens t where t.id = ? and ${LIVE}`).get(id))
  }

  touch(id: string, net: string | null): void {
    this.db
      .prepare('update core_share_tokens set last_used_at = ?, last_used_net = ? where id = ?')
      .run(this.services.clock.now(), net, id)
  }
}

const stores = new WeakMap<RelayServices, ShareStore>()
const limiters = new WeakMap<RelayServices, RateLimiter>()
const storeOf = (s: RelayServices): ShareStore => {
  const have = stores.get(s)
  if (have) return have
  const v = new ShareStore(s)
  stores.set(s, v)
  return v
}
// Our own limiter on the injected clock: the share buckets must hold under test auth too, and a share is not a login.
const limiterOf = (s: RelayServices): RateLimiter => {
  const have = limiters.get(s)
  if (have) return have
  const v = new RateLimiter(s.clock)
  limiters.set(s, v)
  return v
}

/** Advertises `share/1` (unless the owner switched shares off) so Settings works with the Mac offline. */
export function registerShare(services: RelayServices): void {
  if (services.env.SHARE_ENABLED) registerRelayFeature(SHARE_FEATURE)
}

const off = (c: Context<AppEnv>) => !c.get('services').env.SHARE_ENABLED
const notFound = (c: Context<AppEnv>) => c.json({ error: 'not_found' }, 404)

const CreateBody = z
  .object({ label: z.string().trim().min(1).max(40), scopes: z.array(ShareScope).min(1).max(2) })
  .strict()
  .refine((b) => b.scopes.includes('text'), { message: "scopes always contain 'text'" })

export const shareRoutes = new Hono<AppEnv>()

// SHARE_ENABLED=0 is a 404 on every share route, before any auth (docs/V2-FEATURES.md V4.6).
const gate = async (c: Context<AppEnv>, next: () => Promise<void>) => (off(c) ? notFound(c) : next())
shareRoutes.use('/api/share', gate)
shareRoutes.use('/api/share/*', gate)
shareRoutes.use('/share-target', gate)

// ---- token management (the owner's session) ------------------------------------------------------------------------

shareRoutes.get('/api/share/tokens', requireSession, (c) => {
  if (off(c)) return notFound(c)
  return c.json(storeOf(c.get('services')).list())
})

shareRoutes.post('/api/share/tokens', requireSession, requireCsrf, async (c) => {
  if (off(c)) return notFound(c)
  const store = storeOf(c.get('services'))
  const deviceId = getSession(c)?.deviceId
  if (!deviceId || !store.deviceOk(deviceId)) return c.json({ error: 'device_not_pinned' }, 403)
  const body = CreateBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'bad_request' }, 400)
  if (store.activeCount() >= SHARE_LIMITS.activeTokens)
    return c.json({ error: 'too_many_tokens', message: 'Revoke a share link first (10 at most).' }, 409)
  const scopes: ShareScopeT[] = body.data.scopes.includes('files') ? ['text', 'files'] : ['text']
  return c.json(store.create({ label: body.data.label, scopes, deviceId }))
})

shareRoutes.delete('/api/share/tokens/:id', requireSession, requireCsrf, (c) => {
  if (off(c)) return notFound(c)
  return storeOf(c.get('services')).revoke(c.req.param('id')) ? c.body(null, 204) : notFound(c)
})

// ---- token management (the Mac, signed bridge HTTP; P1 `talos-app share shortcut` / `share revoke`) --------------------

/** Bodies here are tiny: 4 KiB is far above a label, a device id and two scopes. */
const BRIDGE_BODY_CAP = 4096

async function bridgeSigned(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  if (!preflightBridgeHttp(c).ok) return c.json({ error: 'unauthorized' }, 401)
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > BRIDGE_BODY_CAP) return c.json({ error: 'too_large' }, 413)
  const body = new Uint8Array(await c.req.arrayBuffer())
  if (body.length > BRIDGE_BODY_CAP) return c.json({ error: 'too_large' }, 413)
  const res = await verifyBridgeHttp(c, body)
  return res.ok ? body : c.json({ error: 'unauthorized' }, 401)
}

const BridgeCreateBody = z
  .object({ label: z.string().trim().min(1).max(40), device_id: DeviceId, scopes: z.array(ShareScope).min(1).max(2) })
  .strict()
  .refine((b) => b.scopes.includes('text'), { message: "scopes always contain 'text'" })

// A fresh token per Shortcut export. Same limits and device binding as the Settings create; the Mac names the device.
shareRoutes.post(
  '/bridge/share/tokens',
  limitBody(() => BRIDGE_BODY_CAP),
  idleBodyTimeout(),
  async (c) => {
    if (off(c)) return notFound(c)
    const body = await bridgeSigned(c)
    if (body instanceof Response) return body
    let raw: unknown = null
    try {
      raw = JSON.parse(new TextDecoder().decode(body))
    } catch {
      // falls through to the 400 below
    }
    const parsed = BridgeCreateBody.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
    const store = storeOf(c.get('services'))
    if (!store.deviceOk(parsed.data.device_id)) return c.json({ error: 'device_not_pinned' }, 403)
    if (store.activeCount() >= SHARE_LIMITS.activeTokens)
      return c.json({ error: 'too_many_tokens', message: 'Revoke a share link first (10 at most).' }, 409)
    const scopes: ShareScopeT[] = parsed.data.scopes.includes('files') ? ['text', 'files'] : ['text']
    return c.json(store.create({ label: parsed.data.label, scopes, deviceId: parsed.data.device_id }))
  },
)

// Idempotent: a token that is already revoked answers 204 again; only an id that never existed is 404. It calls the
// same store revoke as Settings, so there is one revoke path. The relay keeps no separate audit log for either: the
// token row keeps `revoked_at`, which is the record.
shareRoutes.delete(
  '/bridge/share/tokens/:id',
  limitBody(() => BRIDGE_BODY_CAP),
  idleBodyTimeout(),
  async (c) => {
    if (off(c)) return notFound(c)
    const body = await bridgeSigned(c)
    if (body instanceof Response) return body
    const store = storeOf(c.get('services'))
    const id = c.req.param('id')
    if (!store.exists(id)) return notFound(c)
    store.revoke(id)
    return c.body(null, 204)
  },
)

// ---- the token's one route ------------------------------------------------------------------------------------------

const authed = new WeakMap<Request, ShareTokenT>()

function ipOf(c: Context<AppEnv>): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming
  return clientIp(
    { realIp: c.req.header('x-real-ip'), xff: c.req.header('x-forwarded-for') },
    incoming?.socket?.remoteAddress,
    c.get('services').env.TRUST_PROXY_HOPS,
  )
}

const tooMany = (c: Context<AppEnv>, retryAfterS: number) =>
  c.json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfterS) })

/** Steps 1-3 of V4.3: 10/min/IP before the lookup, the lookup (join to the device), then 30/hour/token. */
async function shareAuth(c: Context<AppEnv>, next: () => Promise<void>) {
  if (off(c)) return notFound(c)
  const services = c.get('services')
  const ip = ipOf(c)
  const limiter = limiterOf(services)
  const byIp = limiter.take('share_ip', ip)
  if (!byIp.ok) return tooMany(c, byIp.retryAfterS)
  const m = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')
  const secret = m?.[1]
  const token = secret && SHARE_SECRET_RE.test(secret) ? storeOf(services).lookup(secret) : null
  if (!token) return c.json({ error: 'share_token_invalid', message: 'That share link is not valid.' }, 401)
  const byToken = limiter.take('share_token', token.id)
  if (!byToken.ok) return tooMany(c, byToken.retryAfterS)
  authed.set(c.req.raw, token)
  await next()
}

/** Multipart part names that carry files: `file` is what the iOS Shortcut recipe sends, `files` is the manifest's. */
export const SHARE_FILE_FIELDS = ['file', 'files'] as const

type Parsed = { body: z.infer<typeof SharePostBody>; files: File[] } | { error: string; status: 400 | 413 }

const FIELDS = ['text', 'url', 'title', 'note'] as const

/** Shortcuts send empty fields for the ones the owner skipped; those mean "absent". */
function cleanFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim() === '' && (FIELDS as readonly string[]).includes(k)) continue
    out[k] = v
  }
  // A link that is not a valid web URL is still the owner's material: keep it as text instead of refusing the share.
  if (typeof out.url === 'string' && !HttpsUrl.safeParse(out.url).success) {
    out.text = typeof out.text === 'string' ? `${out.url}\n${out.text}` : out.url
    out.url = undefined
  }
  // iOS shares a web page as its bare link: that is the url, not text.
  if (out.url === undefined && typeof out.text === 'string') {
    const t = out.text.trim()
    if (!/\s/.test(t) && /^https?:\/\//i.test(t) && HttpsUrl.safeParse(t).success) {
      out.url = t
      out.text = undefined
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

async function parseShare(c: Context<AppEnv>): Promise<Parsed> {
  const type = (c.req.header('content-type') ?? '').toLowerCase()
  let fields: Record<string, unknown>
  let files: File[] = []
  if (type.startsWith('multipart/form-data')) {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return { error: 'bad_request', status: 400 }
    }
    fields = {}
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') fields[k] = v
      else if ((SHARE_FILE_FIELDS as readonly string[]).includes(k)) {
        if (v.size > 0) files.push(v)
      } else return { error: 'bad_request', status: 400 }
    }
  } else if (type.startsWith('application/json')) {
    const j = await c.req.json().catch(() => null)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'bad_request', status: 400 }
    fields = j as Record<string, unknown>
  } else return { error: 'bad_request', status: 400 }
  const body = SharePostBody.safeParse(cleanFields(fields))
  if (!body.success) return { error: 'bad_request', status: 400 }
  if (files.length > SHARE_LIMITS.files) return { error: 'too_many_files', status: 413 }
  if (files.some((f) => f.size > SHARE_LIMITS.fileBytes)) return { error: 'too_large', status: 413 }
  files = files.slice(0, SHARE_LIMITS.files)
  return { body: body.data, files }
}

shareRoutes.post(
  '/api/share',
  shareAuth,
  limitBody((c) => (authed.get(originalRequest(c))?.scopes.includes('files') ? FILES_BODY_CAP : TEXT_BODY_CAP)),
  idleBodyTimeout(60_000),
  async (c) => {
    const services = c.get('services')
    const token = authed.get(originalRequest(c)) as ShareTokenT
    const parsed = await parseShare(c)
    if ('error' in parsed) return c.json({ error: parsed.error }, parsed.status)
    if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
    const { body, files } = parsed
    if (files.length > 0 && !token.scopes.includes('files'))
      return c.json({ error: 'files_not_allowed', message: 'This share link cannot send files.' }, 403)
    if (!shareHasContent(body, files.length)) return c.json({ error: 'empty_share' }, 400)

    const shares = storeOf(services)
    const invalid = () => c.json({ error: 'share_token_invalid', message: 'That share link is not valid.' }, 401)
    // The token was checked on the headers; a revoke may have landed while the body uploaded (V4.3 "revocable").
    if (!shares.stillValid(token.id)) return invalid()

    const rt = runtimeOf(services)
    const now = services.clock.now()
    const incoming = files.reduce((n, f) => n + f.size, 0)
    if (incoming > 0) {
      // Shares have their own daily budget, and never push the relay past the owner's daily upload budget (MEDIA_DAILY_MAX_MB) either.
      const total = rt.store.uploadedBytesSince(now - DAY_MS)
      if (
        shareBytesSince(services.db, now - DAY_MS) + incoming > SHARE_DAILY_BYTES ||
        total + incoming > services.env.MEDIA_DAILY_MAX_MB * MIB
      )
        return tooMany(c, 3600)
    }
    const attachments: AttachmentRefT[] = []
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const { ref } = rt.media.save({ bytes, claimedMime: f.type, name: f.name || 'shared file', origin: 'app' })
      services.db
        .prepare('insert or ignore into core_share_uploads (media_id, size, created_at) values (?, ?, ?)')
        .run(ref.media_id, ref.size, now)
      attachments.push(ref)
    }
    const drop = async () => {
      for (const a of attachments) await rt.media.remove(a.media_id)
    }
    if (lateRequest(c)) {
      await drop()
      return c.json({ error: 'request_timeout' }, 408)
    }
    if (!shares.stillValid(token.id)) {
      await drop()
      return invalid()
    }

    const content: ShareContentT = {
      ...(body.text?.trim() ? { text: body.text } : {}),
      ...(body.url ? { url: body.url } : {}),
      ...(body.title?.trim() ? { title: body.title } : {}),
    }
    const hasContent = Object.keys(content).length > 0
    const note = body.note?.trim() ? body.note : ''
    const shareId = newUlid()
    const msgId = newId('m')
    const message = {
      id: msgId,
      thread_id: SHARE_THREAD,
      author: 'owner' as const,
      kind: attachments.length > 0 && !hasContent && !note ? ('file' as const) : ('text' as const),
      text: note,
      format: 'plain' as const,
      attachments,
      via: 'share' as const,
      share_label: token.label,
      created_at: new Date(services.clock.now()).toISOString(),
      ...(hasContent ? { share_content: content } : {}),
    }
    const storedId = newUlid()
    await rt.hub.toApps({ type: 'message.stored', id: storedId, client_msg_id: msgId, message }, { durable: true })
    const seq = rt.store.getEventByFrameId(storedId)?.relay.seq
    await rt.hub.toBridge(
      {
        type: 'share.item',
        share_id: shareId,
        token_id: token.id,
        token_label: token.label,
        message: { ...message, ...(seq !== undefined ? { seq } : {}) },
      },
      { durable: true },
    )
    storeOf(services).touch(token.id, networkOf(ipOf(c)))
    return c.json({ share_id: shareId }, 202)
  },
)

// The service worker normally answers this POST. If one reaches the relay (no SW yet, or a hard reload), the files are
// gone: send the owner to the page, which says so (`?retry=1`) and offers the manual paths.
shareRoutes.post('/share-target', (c) => c.redirect('/share?retry=1', 303))
