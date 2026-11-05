// Share to Talos (docs/V2-FEATURES.md V4.3, V4.7). Shared material is ALWAYS external: on the token path (an iOS Shortcut)
// the whole row arrives as `trust=external`; on the signed `/share` page only the typed note is owner words and the
// material travels in `share_content`, wrapped by the bridge. A token can do one thing: put a row into Inbox.
import { z } from 'zod'
import { DeviceId, HttpsUrl, IsoTs, ShareTokenId } from './ids.ts'

export const SHARE_FEATURE = 'share/1'

export const ShareScope = z.enum(['text', 'files']) // 'text' covers text + url + title + note; 'files' is opt-in
export const ShareToken = z.object({
  id: ShareTokenId,
  label: z.string().min(1).max(40),
  /** Bound: a revoked device's tokens fail at lookup (a join on devices.revoked). */
  device_id: DeviceId,
  scopes: z
    .array(ShareScope)
    .min(1)
    .max(2)
    .refine((s) => s.includes('text'), { message: "scopes always contain 'text'" }),
  created_at: IsoTs,
  last_used_at: IsoTs.nullable(),
  /** Coarse source: IPv4 /24 or IPv6 /48, e.g. "203.0.113.0/24". */
  last_used_net: z.string().max(50).nullable(),
  revoked_at: IsoTs.nullable(),
})

/** `Authorization: Bearer talos_share_<43 base64url>` (32 random bytes). Hashed at rest; shown once. */
export const SHARE_SECRET_RE = /^talos_share_[A-Za-z0-9_-]{43}$/

/** The only target a token can reach. No thread choice, no reads, no other route. */
export const SHARE_THREAD = 'inbox'

// JSON, or multipart with the same names plus <= 4 `file` parts. Strict: a post naming a thread is a 400.
export const SharePostBody = z
  .object({
    text: z.string().max(32_000).optional(),
    url: HttpsUrl.optional(),
    title: z.string().max(300).optional(),
    note: z.string().max(4000).optional(),
  })
  .strict()

/** The non-empty rule, checked by the relay after parsing so multipart file parts count: a photo-only share is valid. */
export function shareHasContent(body: z.infer<typeof SharePostBody>, fileCount: number): boolean {
  const filled = (s: string | undefined) => typeof s === 'string' && s.trim().length > 0
  return filled(body.text) || filled(body.url) || filled(body.note) || fileCount >= 1
}

/** A canonical http(s) URL (`URL.href`), checked without rewriting: it sits inside signed frames. */
const CanonicalUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    try {
      const x = new URL(u)
      return (x.protocol === 'https:' || x.protocol === 'http:') && x.href === u
    } catch {
      return false
    }
  })

/** The shared material. Always wrapped external by the bridge, on both paths. Strict, no defaults (signed frames). */
export const ShareContent = z
  .object({
    text: z.string().max(32_000).optional(),
    url: CanonicalUrl.optional(),
    title: z.string().max(300).optional(),
  })
  .strict()

export const SHARE_LIMITS = {
  activeTokens: 10,
  perIpPerMin: 10,
  perTokenPerHour: 30,
  files: 4,
  fileBytes: 20 * 1024 * 1024,
  pendingFilesMs: 24 * 3600_000,
} as const

export type ShareScopeT = z.infer<typeof ShareScope>
export type ShareTokenT = z.infer<typeof ShareToken>
export type SharePostBodyT = z.infer<typeof SharePostBody>
export type ShareContentT = z.infer<typeof ShareContent>
