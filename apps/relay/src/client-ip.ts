// One place that decides which address a request came from. The rate limits, the bridge-hello block, the hook
// miss limiter and the share link's "last used network" all key on it.
import { isIP } from 'node:net'

export type ClientIpInput = {
  /** `X-Real-IP`, the header Railway documents for the client address. */
  realIp?: string | null | undefined
  /** `X-Forwarded-For`: a comma list. Kept only as the fallback when no usable X-Real-IP arrived. */
  xff?: string | null | undefined
  /** The socket peer. */
  remote?: string | undefined
  /** `TRUST_PROXY_HOPS`. 0 = no proxy in front: every forwarded header is ignored and the socket address is used. */
  hops: number
}

/**
 * Railway's edge sets `X-Real-IP` to the client and overwrites a copy the client sent. `X-Forwarded-For` there holds two
 * entries (client, then a shared edge hop), so reading the entry `hops` from the right keyed every visitor of one
 * edge site to the same address and let one stranger spend the owner's budget. So:
 *  - hops = 0: the socket address only (a local run or a host with no proxy; a header there is client-controlled).
 *  - otherwise a well-formed `X-Real-IP` wins.
 *  - no usable `X-Real-IP`: the old rule (the entry `hops` from the right of `X-Forwarded-For`), so a proxy that only
 *    sets XFF still works.
 */
export function pickClientIp(i: ClientIpInput): string {
  return canonicalAddress(pickRaw(i))
}

function pickRaw(i: ClientIpInput): string {
  if (i.hops > 0) {
    const real = i.realIp?.trim()
    if (real && isIP(real) !== 0) return real
    if (i.xff) {
      const parts = i.xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const pick = parts[parts.length - i.hops]
      if (pick) return pick
    }
  }
  return i.remote ?? 'unknown'
}

/**
 * The key every per-address limit uses. One IPv6 host owns a whole /64, so keying on the full address would hand it a
 * fresh budget per request: group by the /64 (the lower 64 bits become zero, still a valid address). An IPv4-mapped IPv6
 * address (`::ffff:1.2.3.4`, which a dual-stack socket reports) is the same visitor as `1.2.3.4`. Anything that is not an
 * address (`unknown`, a hostile header entry) is returned as is.
 */
export function canonicalAddress(addr: string): string {
  if (isIP(addr) !== 6) return addr
  const groups = expandV6(addr)
  if (!groups) return addr
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] as number
    const lo = groups[7] as number
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::`
}

/** Eight 16-bit groups of a valid IPv6 text address (zone id and a dotted tail included), or null. */
function expandV6(addr: string): number[] | null {
  let a = addr.split('%')[0] as string
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number)
    if (o.some((n) => (n as number) > 255)) return null
    a = `${dotted[1]}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`
  }
  const [head = '', tail = ''] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = a.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : []
  const all = [...h, ...fill, ...t]
  if (all.length !== 8) return null
  const nums = all.map((g) => Number.parseInt(g, 16))
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? nums : null
}
