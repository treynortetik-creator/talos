// Where the owner's Nyx lives (`memory.nyx_url`). Talos only stores the address and links out to it: it holds no Nyx
// credentials. https only, because the owner signs in there. One checker, used by the config schema, the patch check
// (where it is saved) and the web form, so all three agree.
import { z } from 'zod'

export const NYX_URL_MAX = 2000

/** The words a refused address is told (the web form shows them as they are). */
export const NYX_URL_PROBLEM = 'Use a full https address, like https://nyx.example.com'

/** The address as a URL when it is one Talos may keep, else null. No spaces, no http, no sign-in details, no query or fragment, no trailing-dot host, not the sign-in page itself. */
export function parseNyxUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > NYX_URL_MAX) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null
  // a bare '?' or '#' leaves an empty search/hash yet breaks `<address>/sign-in`, so neither may appear at all
  if (/[?#]/.test(value)) return null
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.hostname === '') return null
  // 'nyx.example.com.' is another origin than 'nyx.example.com': the sign-in made there would not carry over
  if (u.hostname.endsWith('.')) return null
  // the address of Nyx itself, not of its sign-in page (that would open '/sign-in/sign-in')
  if (/\/sign-in\/*$/i.test(u.pathname)) return null
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null
  return u
}

/** What the config file stores: the address checked, written the way a URL normalises it. */
export const NyxUrl = z
  .string()
  .max(NYX_URL_MAX)
  .refine((v) => parseNyxUrl(v) !== null, NYX_URL_PROBLEM)
  .transform((v) => (parseNyxUrl(v) as URL).href)

function base(nyxUrl: string): string | null {
  const u = parseNyxUrl(nyxUrl)
  return u === null ? null : u.href.replace(/\/+$/, '')
}

/** `<nyx_url>/sign-in`, or null when the stored address is not one Talos may open. */
export function nyxSignInUrl(nyxUrl: string): string | null {
  const b = base(nyxUrl)
  return b === null ? null : `${b}/sign-in`
}

/** The address to open Nyx itself, or null. */
export function nyxOpenUrl(nyxUrl: string): string | null {
  return parseNyxUrl(nyxUrl)?.href ?? null
}

/** The host the owner reads in "Connected to <host>", or null. */
export function nyxHost(nyxUrl: string): string | null {
  return parseNyxUrl(nyxUrl)?.host ?? null
}
