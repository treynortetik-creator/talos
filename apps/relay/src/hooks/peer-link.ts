// One-paste link, relay side (store and rules). A code is `talos-link:<host>/<conn_id>/<token>`: single use, 15 minutes, only the SHA-256
// of the token stored. The other install redeems it (peer-link-routes.ts) and gets this inbox's secret once; what it sends back
// (its own inbox url and secret) waits, encrypted, until this install's Mac collects it once. Nothing here is pushed or shown in an app.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { formatPeerLinkCode, PEER_LINK_SWEEP_MS, PEER_LINK_TTL_MS, type PeerLinkStateT } from '@talos-app/protocol'
import { isPeerInbox } from './peer.ts'
import { getConn, secretsFor } from './store.ts'
import type { HooksRuntime } from './types.ts'

const te = new TextEncoder()
const td = new TextDecoder()
const sha = (s: string): Buffer => createHash('sha256').update(s).digest()
const aad = (codeId: string): string => `hooks_peer_links:${codeId}:back_secret`

type Row = {
  code_id: string
  conn_id: string
  token_hash: string
  expires_at: number
  state: 'open' | 'redeemed' | 'collected' | 'expired'
  back_url: string | null
  back_secret_enc: Buffer | null
  replayed: number
}
const COLS = 'code_id, conn_id, token_hash, expires_at, state, back_url, back_secret_enc, replayed'

export type MintResult = { ok: true; code: string } | { ok: false; error: 'link_origin' | 'link_pending' }

/** A fresh code for the connection. Replaces its open one; refuses while a redeemed one waits for the Mac. */
export function mintLink(rt: HooksRuntime, connId: string): MintResult {
  const { db, env } = rt.services
  let token = randomBytes(32).toString('base64url')
  while (token.includes('whsec_')) token = randomBytes(32).toString('base64url') // a code never looks like a secret on a command line
  const code = formatPeerLinkCode(env.PUBLIC_ORIGIN, connId, token)
  if (code === null) return { ok: false, error: 'link_origin' }
  const now = rt.now()
  return db.transaction((): MintResult => {
    if (db.prepare("select 1 from hooks_peer_links where conn_id = ? and state = 'redeemed'").get(connId))
      return { ok: false, error: 'link_pending' }
    db.prepare("delete from hooks_peer_links where conn_id = ? and state = 'open'").run(connId)
    db.prepare(
      "insert into hooks_peer_links (code_id, conn_id, token_hash, expires_at, state) values (?, ?, ?, ?, 'open')",
    ).run(`lk_${randomBytes(12).toString('hex')}`, connId, sha(token).toString('hex'), now + PEER_LINK_TTL_MS)
    return { ok: true, code }
  })()
}

export type Refused = 'unknown_conn' | 'no_open_code' | 'already_used' | 'expired' | 'wrong_token' | 'race'

/**
 * The redeem itself, in ONE transaction: the code is found by connection id, must be open and unexpired, and the token's hash is compared to the
 * stored hash in constant time (both are 32-byte digests). The state change `open -> redeemed` is a conditional update: of two racing redeems,
 * exactly one changes a row. A's inbox secret is the connection's current signing secret (`secretsFor`, the one the relay verifies with).
 */
export function redeemLink(
  rt: HooksRuntime,
  a: { connId: string; token: string; backUrl: string; backSecret: string },
): { ok: true; secret: string } | { ok: false; why: Refused } {
  const { db, crypto } = rt.services
  const given = sha(a.token) // hashed first, whatever happens next, so a miss takes the same work
  return db.transaction((): { ok: true; secret: string } | { ok: false; why: Refused } => {
    const conn = getConn(rt, a.connId)
    if (!conn || !isPeerInbox(conn)) return { ok: false, why: 'unknown_conn' }
    const row = db.prepare(`select ${COLS} from hooks_peer_links where conn_id = ? and state = 'open'`).get(a.connId) as
      | Row
      | undefined
    if (!row) {
      const last = db
        .prepare(`select ${COLS} from hooks_peer_links where conn_id = ? order by rowid desc limit 1`)
        .get(a.connId) as Row | undefined
      if (!last) return { ok: false, why: 'no_open_code' }
      // The right token on a code that was already used: a second holder (or the owner's retry). The Mac is told on its next read.
      const same = Buffer.from(last.token_hash, 'hex')
      if (same.length === given.length && timingSafeEqual(same, given))
        db.prepare('update hooks_peer_links set replayed = 1 where code_id = ?').run(last.code_id)
      return { ok: false, why: 'already_used' }
    }
    const stored = Buffer.from(row.token_hash, 'hex')
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return { ok: false, why: 'wrong_token' }
    const now = rt.now()
    if (row.expires_at <= now) return { ok: false, why: 'expired' }
    const secret = secretsFor(rt, conn.id)[0]
    if (!secret) return { ok: false, why: 'unknown_conn' }
    const enc = Buffer.from(crypto.encrypt(te.encode(a.backSecret), aad(row.code_id)))
    const done = db
      .prepare(
        "update hooks_peer_links set state = 'redeemed', redeemed_at = ?, back_url = ?, back_secret_enc = ? where code_id = ? and state = 'open' and expires_at > ?",
      )
      .run(now, a.backUrl, enc, row.code_id, now)
    if (done.changes !== 1) return { ok: false, why: 'race' }
    return { ok: true, secret }
  })()
}

/** What the Mac sees for its newest code. The first read after a redeem returns the back url and secret and wipes the ciphertext. */
export function collectLink(rt: HooksRuntime, connId: string): PeerLinkStateT | null {
  const { db, crypto } = rt.services
  return db.transaction((): PeerLinkStateT | null => {
    const row = db
      .prepare(`select ${COLS} from hooks_peer_links where conn_id = ? order by rowid desc limit 1`)
      .get(connId) as Row | undefined
    if (!row) return null
    const now = rt.now()
    const replayed = row.replayed === 1 ? ({ replayed: true } as const) : {}
    if (row.state === 'open') return { state: row.expires_at <= now ? 'expired' : 'open', ...replayed }
    if (row.state !== 'redeemed' || !row.back_url || !row.back_secret_enc) return { state: row.state, ...replayed }
    const secret = td.decode(crypto.decrypt(row.back_secret_enc, aad(row.code_id)))
    db.prepare(
      "update hooks_peer_links set state = 'collected', collected_at = ?, back_secret_enc = null where code_id = ?",
    ).run(now, row.code_id)
    return { state: 'redeemed', back_url: row.back_url, back_secret: secret, ...replayed }
  })()
}

/** Rows go 24 hours after they expired or were collected (a redeemed one nobody collected goes the same way). */
export function sweepPeerLinks(rt: HooksRuntime): void {
  const cut = rt.now() - PEER_LINK_SWEEP_MS
  rt.services.db
    .prepare('delete from hooks_peer_links where expires_at < ? or (collected_at is not null and collected_at < ?)')
    .run(cut, cut)
}
