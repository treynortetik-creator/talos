import { monotonicFactory } from 'ulid'
import { z } from 'zod'

const ulid = monotonicFactory() // ids created in the same millisecond still sort in creation order

// Crockford base32 without I L O U: what `ulid` emits.
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}'

export const Ulid = z.string().regex(new RegExp(`^${ULID_BODY}$`))
export const IsoTs = z.iso.datetime({ offset: true })
/** `sha256:<64 lowercase hex>`: card payload hashes, schedule etags and content hashes. */
export const Sha256Ref = z.string().regex(/^sha256:[0-9a-f]{64}$/)
/** Names every object already has (`constructor`, `toString`, ...). As a key they read back a function, not "nothing yet". */
const INHERITED_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype))
/**
 * True when `id` would collide with something every object inherits. Checked only where a NEW thread id is made (the slug
 * functions append `_thread`; explicit ids and adds from the app are refused). It is never part of parsing: an id that
 * was stored before the rule must keep loading.
 */
export const isInheritedName = (id: string): boolean => INHERITED_NAMES.has(id)
/** A record's own value for `key`: a key that is not set reads as undefined even when it names an inherited member. */
export const ownValue = <T>(rec: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined =>
  rec != null && Object.hasOwn(rec, key) ? rec[key] : undefined
export const ThreadId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/)
  .refine((id) => id !== 'all') // 'all' is a view, not a thread
export const MsgId = z.string().regex(new RegExp(`^m_${ULID_BODY}$`))
export const CardId = z.string().regex(new RegExp(`^c_${ULID_BODY}$`))
export const EventId = z.string().regex(new RegExp(`^e_${ULID_BODY}$`))
export const MediaId = z.string().regex(new RegExp(`^md_${ULID_BODY}$`))
export const VoiceId = z.string().regex(new RegExp(`^v_${ULID_BODY}$`))
/** MCP Apps (M3.1): one shown app view. */
export const ViewId = z.string().regex(new RegExp(`^av_${ULID_BODY}$`))
/** MCP Apps: one signed request from a view (`tools/call`, `ui/message`). */
export const AppRequestId = z.string().regex(new RegExp(`^ar_${ULID_BODY}$`))
/** = Claude Code's tool_use_id. Validated before it touches any file name. */
export const CaptureId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
/**
 * http(s) only. z.url() alone accepts javascript: and data:, and a regex over the raw string accepts leading whitespace
 * and embedded newlines, so this parses with URL, rejects any whitespace or control character, and stores `URL.href`.
 */
export const HttpsUrl = z
  .string()
  .max(2000)
  .refine((u) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\s\u0000-\u001f\u007f]/.test(u)) return false
    try {
      const p = new URL(u).protocol
      return p === 'http:' || p === 'https:'
    } catch {
      return false
    }
  })
  .transform((u) => new URL(u).href)
export const DeviceId = z.string().regex(/^d_[a-z2-7]{20}$/) // base32(sha256(spki))[:20]
export const ConnId = z.string().regex(/^cn_[0-9A-Za-z]{22}$/) // >=128 bits random; doubles as a capability
export const IntegrationId = z.enum([
  'generic',
  'zapier',
  'make',
  'n8n',
  'gmail',
  'forward',
  'rss',
  'github',
  'slack',
  'jira',
  'gcal',
  'linear',
  'stripe',
  'calendly',
  'gmail_work',
  'zoom',
  'salesforce',
  /** Not an inbound integration: the owner-signed switch for work-class Heartbeat items (config.work.enabled). */
  'heartbeat',
])

// ---- v2 features (docs/V2-FEATURES.md V1.1) -----------------------------------------------------------------------
export const ShareTokenId = z.string().regex(new RegExp(`^sh_${ULID_BODY}$`))
export const MemoryRootId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)

/**
 * A relative POSIX path inside a memory root: not empty, no leading or trailing '/', no empty, '.' or '..' segment, no
 * NUL/C0/DEL, no '\\', at most 512 UTF-8 bytes. Out-of-scope paths are refused by the schema before any filesystem call.
 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (new TextEncoder().encode(p).length > 512) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}
export const MemoryPath = z.string().max(512).refine(isSafeRelPath, { message: 'not a safe relative path' })
/** Opaque to the app (search and memory listing pages). */
export const PageCursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)

export type ThreadIdT = z.infer<typeof ThreadId>
export type IntegrationIdT = z.infer<typeof IntegrationId>

export type IdPrefix = 'm' | 'c' | 'e' | 'md' | 'v' | 'sh' | 'd'

/** A bare ULID, used for frame ids. */
export function newUlid(): string {
  return ulid()
}

/** Prefixed id: `m_<ULID>`, `c_`, `e_`, `md_`, `v_`, `sh_`. Device ids (`d_`) come from `deviceIdFromSpki` instead. */
export function newId(prefix: Exclude<IdPrefix, 'd'>): string {
  return `${prefix}_${ulid()}`
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `cn_` + 22 base62 chars drawn from the CSPRNG with rejection sampling (about 131 bits). */
export function newConnectionId(): string {
  let out = ''
  while (out.length < 22) {
    const buf = new Uint8Array(32)
    globalThis.crypto.getRandomValues(buf)
    for (const b of buf) {
      if (b < 248 && out.length < 22) out += BASE62[b % 62] // 248 = 62 * 4: unbiased
    }
  }
  return `cn_${out}`
}
