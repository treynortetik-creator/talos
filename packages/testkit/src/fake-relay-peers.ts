// FakeRelay's peer inboxes (linked agents): the Mac's setup routes (POST/GET /bridge/peers, DELETE /bridge/peers/:name, POST
// /bridge/peers/:name/rotate) and the signed inbox (POST /hook/peer/:connId) with the real relay's order of checks: Standard
// Webhooks headers, the body, header id = body id, the 7-day dedupe, the daily cap per UTC day, then one durable `peer.message`
// frame for the Mac. The signature check is written out here (HMAC-SHA256, the 5-minute window) so it is an independent reader of
// what the bridge signs. A revoke removes the frames the Mac has not taken, like the real relay.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  formatPeerLinkCode,
  newUlid,
  PEER_DAILY_CAP_DEFAULT,
  PEER_LINK_TTL_MS,
  PEER_MAX,
  PeerCreate,
  PeerLinkRedeem,
  parsePeerMessage,
  peerInboxUrl,
} from '@talos-app/protocol'

type Row = { conn_id: string; name: string; cap: number; created_at: number; secrets: string[] }
type Answer = { status: number; body: unknown }

export type PeerHost = {
  now(): number
  origin(): string
  /** Hands a durable frame to the Mac (buffered while it is away). */
  toBridge(frame: Record<string, unknown>): Record<string, unknown>
  /** Drops queued frames of this type for which `drop` is true that the Mac has not taken (delivered = false). */
  recallQueued(drop: (frame: Record<string, unknown>) => boolean): void
}

type Link = {
  hash: Buffer
  expires: number
  state: 'open' | 'redeemed' | 'collected'
  backUrl?: string
  backSecret?: string
  replayed: boolean
}

const DAY_MS = 86_400_000
const WINDOW_MS = 5 * 60_000

const keyOf = (secret: string): Buffer | null => {
  const b64 = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const key = Buffer.from(b64, 'base64')
  return key.length >= 24 && key.length <= 64 ? key : null
}

export class FakePeers {
  readonly rows: Row[] = []
  /** Every inbox answer, for a test to read: the conn, the status and the error code (when there was one). */
  readonly answers: Array<{ conn_id: string; status: number; error?: string }> = []
  /** What the relay accepted, per connection: the webhook ids, with the day (UTC) they were counted. */
  private readonly seen = new Map<string, Set<string>>()
  private readonly counts = new Map<string, { day: number; n: number }>()
  /** Set to make the inbox answer this status (with `error`) before any check, like a relay that is down. */
  refuse: { status: number; error: string } | null = null

  /** The public origin this relay claims (https, so a link code can name it). Unset: the real listening address, as before. */
  publicOrigin: string | null = null
  /** The one-paste link codes, newest per connection (the real relay's table, in memory). */
  readonly links = new Map<string, Link>()
  /** Every redeem attempt's answer status, for a test to read. */
  readonly redeems: number[] = []
  /** How many failed redeems from one client the relay tolerates in a minute (the real one: 20). */
  private failures: number[] = []

  constructor(private readonly host: PeerHost) {}

  private origin(): string {
    return this.publicOrigin ?? this.host.origin()
  }

  mintLink(name: string): Answer {
    const row = this.rows.find((r) => r.name === name)
    if (!row) return { status: 404, body: { error: 'not_found' } }
    const token = randomBytes(32).toString('base64url')
    const code = formatPeerLinkCode(this.origin(), row.conn_id, token)
    if (code === null) return { status: 409, body: { error: 'link_origin' } }
    if (this.links.get(row.conn_id)?.state === 'redeemed') return { status: 409, body: { error: 'link_pending' } }
    this.links.set(row.conn_id, {
      hash: createHash('sha256').update(token).digest(),
      expires: this.host.now() + PEER_LINK_TTL_MS,
      state: 'open',
      replayed: false,
    })
    return { status: 200, body: { code } }
  }

  getLink(name: string): Answer {
    const row = this.rows.find((r) => r.name === name)
    const l = row ? this.links.get(row.conn_id) : undefined
    if (!l) return { status: 404, body: { error: 'not_found' } }
    const replayed = l.replayed ? { replayed: true } : {}
    if (l.state === 'open')
      return { status: 200, body: { state: l.expires <= this.host.now() ? 'expired' : 'open', ...replayed } }
    if (l.state === 'collected' || !l.backUrl || !l.backSecret)
      return { status: 200, body: { state: l.state, ...replayed } }
    const out = { state: 'redeemed', back_url: l.backUrl, back_secret: l.backSecret, ...replayed }
    l.state = 'collected'
    delete l.backSecret
    return { status: 200, body: out }
  }

  redeem(raw: unknown): Answer {
    const now = this.host.now()
    this.failures = this.failures.filter((t) => now - t < 60_000)
    if (this.failures.length >= 20) return this.redeemed(429, { error: 'too_many_requests' })
    const fail = (status: number, error: string): Answer => {
      this.failures.push(now)
      return this.redeemed(status, { error })
    }
    const body = PeerLinkRedeem.safeParse(raw)
    if (!body.success) return fail(400, 'bad_request')
    const row = this.rows.find((r) => r.conn_id === body.data.conn_id)
    const l = row ? this.links.get(row.conn_id) : undefined
    const given = createHash('sha256').update(body.data.token).digest()
    if (!row || !l || !timingSafeEqual(given, l.hash)) return fail(404, 'link_unusable')
    if (l.state !== 'open') {
      l.replayed = true
      return fail(404, 'link_unusable')
    }
    if (l.expires <= now) return fail(404, 'link_unusable')
    l.state = 'redeemed'
    l.backUrl = body.data.back.url
    l.backSecret = body.data.back.secret
    return this.redeemed(200, { secret: row.secrets[0] })
  }

  private redeemed(status: number, body: unknown): Answer {
    this.redeems.push(status)
    return { status, body }
  }

  create(raw: unknown): Answer {
    const body = PeerCreate.safeParse(raw)
    if (!body.success) return { status: 400, body: { error: 'bad_request' } }
    if (this.rows.some((r) => r.name === body.data.name)) return { status: 409, body: { error: 'peer_exists' } }
    if (this.rows.length >= PEER_MAX) return { status: 409, body: { error: 'too_many_peers', max: PEER_MAX } }
    const secret = `whsec_${randomBytes(32).toString('base64')}`
    const row: Row = {
      conn_id: `cn_${randomBytes(24).toString('hex').slice(0, 22)}`,
      name: body.data.name,
      cap: body.data.daily_cap ?? PEER_DAILY_CAP_DEFAULT,
      created_at: this.host.now(),
      secrets: [secret],
    }
    this.rows.push(row)
    return {
      status: 201,
      body: { conn_id: row.conn_id, inbox_url: peerInboxUrl(this.origin(), row.conn_id), secret },
    }
  }

  list(): Answer {
    return {
      status: 200,
      body: this.rows.map((r) => ({
        conn_id: r.conn_id,
        name: r.name,
        daily_cap: r.cap,
        created_at: new Date(r.created_at).toISOString(),
        received_today: this.countToday(r.conn_id),
      })),
    }
  }

  remove(name: string): Answer {
    const i = this.rows.findIndex((r) => r.name === name)
    if (i >= 0) {
      const [gone] = this.rows.splice(i, 1)
      this.host.recallQueued((f) => f.type === 'peer.message' && f.conn_id === gone?.conn_id)
      if (gone) this.links.delete(gone.conn_id)
    }
    return { status: 200, body: { ok: true } }
  }

  rotate(name: string): Answer {
    const row = this.rows.find((r) => r.name === name)
    if (!row) return { status: 404, body: { error: 'not_found' } }
    const secret = `whsec_${randomBytes(32).toString('base64')}`
    row.secrets = [secret, ...row.secrets.slice(0, 1)] // the old one stays valid for a while
    return { status: 200, body: { secret } }
  }

  private countToday(connId: string): number {
    const c = this.counts.get(connId)
    return c && c.day === Math.floor(this.host.now() / DAY_MS) ? c.n : 0
  }

  /** One delivery to /hook/peer/:connId. */
  inbox(connId: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Answer {
    const out = (status: number, error?: string, extra: Record<string, unknown> = {}): Answer => {
      this.answers.push({ conn_id: connId, status, ...(error ? { error } : {}) })
      return { status, body: error ? { error, ...extra } : { ok: true } }
    }
    if (this.refuse) return out(this.refuse.status, this.refuse.error)
    const row = this.rows.find((r) => r.conn_id === connId)
    if (!row) return out(404, 'not_found')
    const h = (n: string): string => String(headers[n] ?? '')
    const id = h('webhook-id')
    const ts = h('webhook-timestamp')
    const sigs = h('webhook-signature')
      .split(' ')
      .filter((s) => s.startsWith('v1,'))
      .map((s) => s.slice(3))
    if (!id || !/^\d{1,12}$/.test(ts) || sigs.length === 0) return out(401, 'unauthorized')
    if (Math.abs(this.host.now() - Number(ts) * 1000) > WINDOW_MS) return out(401, 'unauthorized')
    const verified = row.secrets.some((s) => {
      const key = keyOf(s)
      if (!key) return false
      const mac = createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest()
      return sigs.some((x) => {
        const got = Buffer.from(x, 'base64')
        return got.length === mac.length && timingSafeEqual(got, mac)
      })
    })
    if (!verified) return out(401, 'unauthorized')
    let parsed: ReturnType<typeof parsePeerMessage>
    try {
      parsed = parsePeerMessage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
    } catch {
      return out(400, 'bad_body')
    }
    if (!parsed.success) return out(400, 'bad_body')
    const msg = parsed.data
    if (msg.id !== id) return out(400, 'id_mismatch')
    const seen = this.seen.get(connId) ?? new Set<string>()
    this.seen.set(connId, seen)
    if (seen.has(id)) return out(200)
    const day = Math.floor(this.host.now() / DAY_MS)
    if (this.countToday(connId) >= row.cap) {
      return out(429, 'daily_cap', { retry_after_s: Math.ceil(((day + 1) * DAY_MS - this.host.now()) / 1000) })
    }
    seen.add(id)
    this.counts.set(connId, { day, n: this.countToday(connId) + 1 })
    this.host.toBridge({
      v: 1,
      type: 'peer.message',
      id: newUlid(),
      ts: new Date(this.host.now()).toISOString(),
      conn_id: connId,
      peer: row.name,
      msg,
      received_at: new Date(this.host.now()).toISOString(),
    })
    return out(200)
  }
}
