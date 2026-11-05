// One web-address safety check for everything in Talos that fetches a URL someone else influences.
//
// Pure functions only (no node: imports), so the web app can bundle this package. The connect-time half, which checks the
// address a socket is really about to open, lives in `guarded-fetch.ts` (node only).
//
// Rule for every caller: classify the ADDRESS, never the name. A name is only ever "not yet known"; resolve it, then ask
// `isBlockedAddress` about every address that came back (`findBlockedAddress`). Anything this file cannot parse is blocked.

/** Four dotted decimal numbers, each 0..255 with no leading zeros. Anything else (octal, hex, short, decimal) is null. */
export function parseIPv4(input: string): number[] | null {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(input)
  if (!m) return null
  const o = [m[1], m[2], m[3], m[4]].map(Number)
  return o.every((n) => n <= 255) ? o : null
}

/** Eight 16-bit groups, or null when the text is not an IPv6 literal. Accepts `::`, a dotted IPv4 tail, brackets and a zone id. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':')) return null
  if (s.includes('.')) {
    const colon = s.lastIndexOf(':')
    const v4 = parseIPv4(s.slice(colon + 1))
    if (!v4) return null
    const hi = ((v4[0] as number) << 8) | (v4[1] as number)
    const lo = ((v4[2] as number) << 8) | (v4[3] as number)
    s = `${s.slice(0, colon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? (halves[0] as string).split(':') : []
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : []
  let groups: string[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  }
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null
}

function v4From(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255]
}

function blockedV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number]
  return (
    a === 0 || // 0.0.0.0/8 this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 carrier-grade NAT
    (a === 169 && b === 254) || // link local, includes the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast and reserved
  )
}

/**
 * True when Talos must not contact this address: not a public unicast address. IPv4 and IPv6, including the IPv6 forms that
 * carry an IPv4 address (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), which are
 * judged by the IPv4 address inside. Text that is not exactly an address (octal, hex, decimal, short forms, a name, empty)
 * is blocked: this answers "is it safe", and "I cannot tell" is not safe.
 */
export function isBlockedAddress(addr: string): boolean {
  const host = addr.replace(/^\[|\]$/g, '')
  const v4 = parseIPv4(host)
  if (v4) return blockedV4(v4)
  const g = parseIPv6(host)
  if (!g) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number]
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeroTo(7) && (g7 === 0 || g7 === 1)) return true // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return true // fec0::/10 site local (deprecated, still routable inside some networks)
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  if (zeroTo(5) && (g5 === 0xffff || g5 === 0)) return blockedV4(v4From(g6, g7)) // ::ffff:a.b.c.d mapped, ::a.b.c.d compatible
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return true // ::ffff:0:a.b.c.d translated
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedV4(v4From(g6, g7)) // 64:ff9b::/96 NAT64
    return g2 === 1 // 64:ff9b:1::/48 local-use NAT64: operator-defined, never public
  }
  if (g0 === 0x2002) return blockedV4(v4From(g1, g2)) // 2002::/16 6to4
  if (g0 === 0x2001 && g1 === 0) return true // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 2 && g2 === 0) return true // 2001:2::/48 benchmarking
  if (g0 === 0x2001 && g1 === 0xdb8) return true // 2001:db8::/32 documentation
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true // 3fff::/20 documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true // 100::/64 discard-only
  return false
}

/** The first blocked address in the list, or undefined when none is. The caller must refuse an empty list itself (no answer is no proof). */
export function findBlockedAddress(addrs: readonly string[]): string | undefined {
  return addrs.find((a) => isBlockedAddress(a))
}

/** A host as it appears in a URL, made comparable: lower case, no brackets, no trailing dots (`localhost.` is `localhost`). */
export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
}

/** True when the (normalized) host is an exact IPv4 or IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host)
  return parseIPv4(h) !== null || parseIPv6(h) !== null
}

/**
 * Judges a host before any lookup. Blocked: an IP literal in a blocked range, and any number-shaped host that is not an exact
 * literal (`0x7f.1`, `2130706433`, `0177.0.0.1`, `127.1`): a resolver may read those as an address, so they are refused rather
 * than guessed at. A real name returns false here: it still has to be resolved and every address checked.
 */
export function isBlockedHost(host: string): boolean {
  const h = normalizeHost(host)
  if (h === '') return true
  if (isIpLiteral(h)) return isBlockedAddress(h)
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.]*$/i.test(h)) return true
  return h.includes(':')
}

/** Names that never belong to a public host: `localhost`, `*.localhost`, `*.local`, `*.internal`, and single-label names. */
export function isBlockedHostname(host: string): boolean {
  const h = normalizeHost(host)
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    (!h.includes('.') && !h.includes(':'))
  )
}

/**
 * `localhost` or a loopback address literal (127.0.0.0/8, ::1, and the mapped form of 127/8). This is the one named
 * exception callers use for an owner-approved local dev server; it is not a range check and it never accepts a name that
 * merely starts with `127.`.
 */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host)
  if (h === 'localhost') return true
  const v4 = parseIPv4(h)
  if (v4) return v4[0] === 127
  const g = parseIPv6(h)
  if (!g) return false
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true
  return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && (g[6] as number) >> 8 === 127
}
