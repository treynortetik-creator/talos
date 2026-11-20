// Linked agents, one-paste link: the code one Talos shows and the other pastes. `talos-link:<relay host>/<conn_id>/<token>`.
// The token is a bearer credential for 15 minutes (single use); the relay keeps only its SHA-256. Everything the two bridges and the
// relay agree on is here: the code format and its parser, the inbox-URL rule, and the shapes of the three link routes.
import { z } from 'zod'
import { isBlockedHost, isBlockedHostname, isIpLiteral } from './address.ts'
import { ConnId } from './ids.ts'

export const PEER_LINK_SCHEME = 'talos-link:'
/** How long a code lives after it is minted. */
export const PEER_LINK_TTL_MS = 15 * 60_000
/** A code's row is swept this long after it expired or was collected. */
export const PEER_LINK_SWEEP_MS = 24 * 3600_000
/** 32 random bytes, base64url without padding. */
export const PeerLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const PEER_LINK_CODE_MAX = 300

/** `whsec_` + standard base64 of 24 to 64 bytes (the relay's secret format), checked on the bytes. */
export const isPeerSecret = (s: string): boolean => {
  if (typeof s !== 'string' || s.length > 200 || !s.startsWith('whsec_')) return false
  const b64 = s.slice(6)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  const n = Buffer.from(b64, 'base64').length
  return n >= 24 && n <= 64
}
export const PeerSecretString = z.string().refine(isPeerSecret, { message: 'not a peer secret' })

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A relay host a code may name: a plain DNS name (a dot in it), no IP literal, nothing private-looking. A port is not part of it. */
export const isLinkHost = (h: string): boolean =>
  HOSTNAME.test(h) && !isIpLiteral(h) && !isBlockedHost(h) && !isBlockedHostname(h) && !/^[0-9.]+$/.test(h)

export type PeerLinkParts = { host: string; conn_id: string; token: string }

/** The code for a relay origin (`https://relay.example.com`), or null when that origin cannot make a usable code (not https, a port, not a plain host). */
export function formatPeerLinkCode(origin: string, connId: string, token: string): string | null {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.port !== '' || !isLinkHost(u.hostname)) return null
  return `${PEER_LINK_SCHEME}${u.hostname}/${connId}/${token}`
}

/**
 * Reads a pasted code. Refuses anything that is not exactly `talos-link:<hostname>[:443]/<conn_id>/<token>`: no scheme but ours,
 * no IP literal, no port but 443, no userinfo, no extra path, query or fragment. Surrounding whitespace is trimmed; inside, none.
 */
export function parsePeerLinkCode(raw: string): { ok: true; value: PeerLinkParts } | { ok: false } {
  const bad = { ok: false } as const
  if (typeof raw !== 'string') return bad
  const s = raw.trim()
  if (s.length > PEER_LINK_CODE_MAX || !s.startsWith(PEER_LINK_SCHEME)) return bad
  const parts = s.slice(PEER_LINK_SCHEME.length).split('/')
  if (parts.length !== 3) return bad
  const [hostPart, connId, token] = parts as [string, string, string]
  const host = hostPart.endsWith(':443') ? hostPart.slice(0, -4) : hostPart
  if (host !== host.toLowerCase() || !isLinkHost(host)) return bad
  if (!ConnId.safeParse(connId).success || !PeerLinkToken.safeParse(token).success) return bad
  return { ok: true, value: { host, conn_id: connId, token } }
}

/** The one builder of an inbox URL: the relay hands it out, B derives A's from the code with it. */
export const peerInboxUrl = (origin: string, connId: string): string =>
  `${origin.replace(/\/+$/, '')}/hook/peer/${connId}`

/**
 * The rule for an inbox URL that arrives from outside (the other install's `back.url`): https, no userinfo, no port but 443, a plain
 * public-looking host, and the path exactly `/hook/peer/<conn_id>` with no query or fragment. Returns the normalised URL or null.
 */
export function checkPeerInboxUrl(raw: unknown): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (typeof raw !== 'string' || raw.length > 300 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '' || u.search || u.hash) return null
  if (!isLinkHost(u.hostname)) return null
  const m = /^\/hook\/peer\/(cn_[0-9A-Za-z]{22})$/.exec(u.pathname)
  return m ? u.href : null
}
export const PeerInboxUrl = z.string().transform((s, ctx) => {
  const ok = checkPeerInboxUrl(s)
  if (ok === null) ctx.addIssue({ code: 'custom', message: 'not a peer inbox url' })
  return ok ?? ''
})

// ---- routes ------------------------------------------------------------------------------------------------------------

/** POST /peer-link/redeem (no auth: B calling A's relay). */
export const PeerLinkRedeem = z.strictObject({
  conn_id: ConnId,
  token: PeerLinkToken,
  back: z.strictObject({ url: PeerInboxUrl, secret: PeerSecretString }),
})
export type PeerLinkRedeemT = z.infer<typeof PeerLinkRedeem>
/** A's inbox secret, once. */
export const PeerLinkRedeemed = z.strictObject({ secret: PeerSecretString })
/** The one answer for every failure of a redeem. */
export const PEER_LINK_UNUSABLE = 'link_unusable'

/** POST /bridge/peers/:name/link */
export const PeerLinkMinted = z.strictObject({ code: z.string().max(PEER_LINK_CODE_MAX) })
export const PeerLinkState = z.strictObject({
  state: z.enum(['open', 'redeemed', 'collected', 'expired']),
  back_url: z.string().optional(),
  back_secret: z.string().optional(),
  /** True once a second try with the same valid token reached the relay: someone else may hold the code. */
  replayed: z.literal(true).optional(),
})
export type PeerLinkStateT = z.infer<typeof PeerLinkState>
