// The setup link `https://<relay>/enroll#<code>[&fp=<bridge key fingerprint>]`. Everything is in the fragment, so no server
// sees it; the code stays first and bare. `fp` is public (see bridgeKeyFingerprint): the phone pins the bridge key by it.
import { normalizeEnrollCode } from './enroll.ts'

export const ENROLL_FP = /^[A-Za-z0-9_-]{43}$/

export type EnrollFragment =
  | { ok: true; code: string; fp?: string }
  | { ok: false; error: 'no_code' | 'bad_fp' | 'dup_fp' | 'bad_link' }

/**
 * Reads a whole link or just its fragment: everything up to the FIRST '#' is dropped (a bare `location.hash` starts with
 * that one), and a second '#' is a bad link. Nothing is percent-decoded: `fp` must match ENROLL_FP as written (base64url
 * needs no encoding), so the native parser can do the same. A bad or repeated `fp` fails the whole parse, as does any key
 * that looks like a mangled `fp` (`FP`, ` fp`, `fp%3D`, `%66p`): a tampered link must never enroll without the pin.
 * Other unknown keys are ignored, for later fields.
 */
export function parseEnrollFragment(input: string): EnrollFragment {
  const trimmed = input.trim()
  const at = trimmed.indexOf('#')
  const frag = at < 0 ? trimmed : trimmed.slice(at + 1)
  if (frag.includes('#')) return { ok: false, error: 'bad_link' }
  const [first = '', ...rest] = frag.split('&')
  const code = normalizeEnrollCode(first)
  if (!code) return { ok: false, error: 'no_code' }
  let fp: string | undefined
  for (const seg of rest) {
    if (!seg) continue
    const eq = seg.indexOf('=')
    const key = eq < 0 ? seg : seg.slice(0, eq)
    const val = eq < 0 ? '' : seg.slice(eq + 1)
    if (key !== 'fp') {
      if (key.includes('%') || key.trim().toLowerCase().startsWith('fp')) return { ok: false, error: 'bad_fp' }
      continue
    }
    if (fp !== undefined) return { ok: false, error: 'dup_fp' }
    if (!ENROLL_FP.test(val)) return { ok: false, error: 'bad_fp' }
    fp = val
  }
  return fp === undefined ? { ok: true, code } : { ok: true, code, fp }
}

export type EnrollLink =
  | { ok: true; origin: string; code: string; fp?: string }
  | { ok: false; error: 'no_code' | 'bad_fp' | 'dup_fp' | 'bad_link' }

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4_PART = /^(?:0|[1-9][0-9]{0,2})$/

/**
 * A whole setup link as the iPhone app scans it: the relay's origin as well as the fragment (docs/specs/BYOR.md §10). The
 * origin is checked as written, never decoded or normalised beyond lower-casing the host: `https://` exactly, no userinfo,
 * a plain ASCII host (no '%', no `xn--` label, no trailing dot, no IPv6 literal; a numeric host only as a plain dotted
 * quad), an optional port 1-65535 written without a leading zero, the path exactly `/enroll`, no query, exactly one '#',
 * and only characters 0x21-0x7E anywhere, so no space (only space, tab, CR and LF are trimmed from the ends). The host
 * is lowercased before any check on it. Anything else is `bad_link`. A lookalike
 * ASCII host can still pass, and the fp pin does not catch it (that link carries its own fp): the host the app shows before
 * pairing is the check there. The web keeps parseEnrollFragment (it enrolls on its own origin).
 */
export function parseEnrollLink(input: string): EnrollLink {
  // ASCII whitespace only at the ends (JS trim() and Swift's differ on BOM, NEL and the like), then printable ASCII only,
  // the fragment included: nothing in a setup link is ever anything else
  const link = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  if (!/^[\x21-\x7e]*$/.test(link)) return { ok: false, error: 'bad_link' }
  const hash = link.indexOf('#')
  if (hash < 0 || link.indexOf('#', hash + 1) >= 0) return { ok: false, error: 'bad_link' }
  const head = link.slice(0, hash)
  if (!head.startsWith('https://')) return { ok: false, error: 'bad_link' }
  const rest = head.slice('https://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0 || rest.slice(slash) !== '/enroll') return { ok: false, error: 'bad_link' }
  const authority = rest.slice(0, slash)
  if (!authority || authority.includes('@')) return { ok: false, error: 'bad_link' } // no userinfo
  const colon = authority.indexOf(':')
  const host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase()
  const port = colon < 0 ? null : authority.slice(colon + 1)
  if (host.length > 253) return { ok: false, error: 'bad_link' }
  const labels = host.split('.')
  if (!labels.every((l) => HOST_LABEL.test(l) && !l.startsWith('xn--'))) return { ok: false, error: 'bad_link' }
  // a host whose last label is a number is an IPv4 address to a browser (WHATWG reads 0x7f.1 or 2130706433 as 127.0.0.1):
  // only the plain dotted quad is taken, so the origin here is the one the web view loads
  const last = labels[labels.length - 1] as string
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last))
    if (labels.length !== 4 || !labels.every((l) => IPV4_PART.test(l) && Number(l) <= 255))
      return { ok: false, error: 'bad_link' }
  if (port !== null && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535))
    return { ok: false, error: 'bad_link' }
  const frag = parseEnrollFragment(link.slice(hash + 1))
  if (!frag.ok) return frag
  const origin = `https://${host}${port !== null && port !== '443' ? `:${port}` : ''}`
  return frag.fp === undefined
    ? { ok: true, origin, code: frag.code }
    : { ok: true, origin, code: frag.code, fp: frag.fp }
}

export function formatEnrollLink(relayUrl: string, code: string, fp?: string): string {
  if (fp !== undefined && !ENROLL_FP.test(fp)) throw new Error('invalid bridge key fingerprint')
  return `${relayUrl}/enroll#${code}${fp !== undefined ? `&fp=${fp}` : ''}`
}
