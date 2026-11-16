// Org pages, phase 1 (docs/ORG-PAGES-SPEC.md, and its "Owner decisions"): an agent publishes an HTML page from a thread; the
// relay keeps it, versioned, past the 7-day media buffer, and serves it to the owner's own logged-in devices in the sandbox
// every agent page runs in. A share (scope and expiry) is stored, but no one else can open a page until viewer sign-in lands
// (phase 3). The agent publishes and updates; it never shares: share, unshare, restore and delete are owner frames, signed by
// the device key.
import { z } from 'zod'
import { DeviceId, IsoTs, PageId, ThreadId } from './ids.ts'

const KIB = 1024
const MIB = KIB * KIB

/** One list of every cap, so the bridge, the relay and the app read the same numbers. */
export const PAGE_LIMITS = {
  /** One version's HTML (UTF-8). */
  versionBytes: 10 * MIB,
  /** Versions kept per page: the 11th drops the oldest (never the current one). */
  versionsPerPage: 10,
  titleChars: 200,
  /** Default relay-wide caps (env PAGES_MAX_MB / PAGES_MAX, clamped); past either a publish is refused with 507 pages_full. */
  totalMb: 500,
  pages: 500,
  /** A share ends this many days after it was made, unless the owner gave another end (or none). */
  shareDefaultDays: 30,
  /** People a share may name. */
  shareEmails: 200,
} as const

/** A version is named by the SHA-256 of its bytes: immutable, and the same bytes twice are one version. */
export const PageHash = z.string().regex(/^[0-9a-f]{64}$/)

export const PageTitle = z
  .string()
  .min(1)
  .max(PAGE_LIMITS.titleChars)
  // one line of visible text: no control characters
  .refine((t) => ![...t].some((ch) => (ch.codePointAt(0) as number) < 0x20 || ch === '\u007f'), 'one line, no controls')

// ---- publish (the bridge, signed with its key) ---------------------------------------------------------------------------

/**
 * `POST /bridge/pages?thread_id=&title=[&page_id=]`, the body the page's HTML bytes (`text/html; charset=utf-8`). The query is
 * signed with the request (the bridge signature covers the path and query), so the relay stores only what the Mac asked for.
 * With `page_id`, a new version of that page, and only a page the same thread published (any other is `not_found`).
 */
export const PagePublishQuery = z.strictObject({
  thread_id: ThreadId,
  title: PageTitle,
  page_id: PageId.optional(),
})
export type PagePublishQueryT = z.infer<typeof PagePublishQuery>

export const PagePublished = z.strictObject({
  page_id: PageId,
  /** The version now current (its hash). */
  version: PageHash,
  /** The bytes were already a version of this page: nothing was added (an older one became current again). */
  unchanged: z.boolean(),
  /** Where the owner opens it (signed in): the page's link, the same one a share will use. */
  owner_url: z.string().url(),
})
export type PagePublishedT = z.infer<typeof PagePublished>

/**
 * What a thread's message carries about a page publish_page put there (`Message.page`): which page and version. No link: the
 * app builds `/p/<page_id>` itself, so a message can never point the owner's Open somewhere else (a thread session may mint
 * this field). Nothing that changes later (versions, share) is in it either: the app reads those from GET /api/pages/:id
 * when it shows the card, so a thread's history never holds a stale share.
 */
export const PageRef = z.strictObject({
  page_id: PageId,
  title: PageTitle,
  version: PageHash,
})
export type PageRefT = z.infer<typeof PageRef>

// ---- the share (stored in phase 1, served from phase 3) ------------------------------------------------------------------

export const PageShareScope = z.enum(['people', 'org'])

export const PageShare = z.strictObject({
  scope: PageShareScope,
  /** `people`: who; `org`: empty (everyone at the company, behind the org sign-in). */
  emails: z.array(z.email().max(254)).max(PAGE_LIMITS.shareEmails),
  shared_at: IsoTs,
  /** When the share ends; null = until the owner unshares. The sweeper ends it then. */
  expires_at: IsoTs.nullable(),
})
export type PageShareT = z.infer<typeof PageShare>

// ---- what the owner's devices read --------------------------------------------------------------------------------------

export const PageVersion = z.strictObject({ hash: PageHash, bytes: z.number().int().nonnegative(), at: IsoTs })

export const PageInfo = z.strictObject({
  id: PageId,
  title: PageTitle,
  thread_id: ThreadId,
  created_at: IsoTs,
  updated_at: IsoTs,
  current: PageHash,
  /** Newest first. */
  versions: z.array(PageVersion).max(PAGE_LIMITS.versionsPerPage),
  share: PageShare.nullable(),
})
export type PageInfoT = z.infer<typeof PageInfo>

/** `GET /api/pages`: every page (newest change first) and how full the store is. */
export const PageList = z.strictObject({
  pages: z.array(PageInfo),
  used_bytes: z.number().int().nonnegative(),
  max_bytes: z.number().int().positive(),
  max_pages: z.number().int().positive(),
})
export type PageListT = z.infer<typeof PageList>

// ---- owner changes (device-signed) ---------------------------------------------------------------------------------------

const signed = {
  v: z.literal(1),
  device_id: DeviceId,
  page_id: PageId,
  ts: IsoTs,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  osig: z.string().length(86),
}

/**
 * The owner's changes to a page, each an owner frame signed by the device key (`signOwnerFrame`), fresh, single use, and for
 * the page in the path. `page.share` makes or replaces the share: to extend one, share again with a later (or no) end;
 * `expires_at` left out = PAGE_LIMITS.shareDefaultDays from now.
 */
export const PageOwnerAction = z.discriminatedUnion('type', [
  z.strictObject({
    ...signed,
    type: z.literal('page.share'),
    scope: PageShareScope,
    emails: z.array(z.email().max(254)).max(PAGE_LIMITS.shareEmails),
    expires_at: IsoTs.nullable().optional(),
  }),
  z.strictObject({ ...signed, type: z.literal('page.unshare') }),
  z.strictObject({ ...signed, type: z.literal('page.current'), hash: PageHash }),
  z.strictObject({ ...signed, type: z.literal('page.delete') }),
])
export type PageOwnerActionT = z.infer<typeof PageOwnerAction>

/** The route each action is posted to, under `/api/pages/:id` (DELETE for `page.delete`). */
export const PAGE_ACTION_PATH = {
  'page.share': 'share',
  'page.unshare': 'unshare',
  'page.current': 'current',
  'page.delete': '',
} as const

/** 507 past the relay's page caps: its own code, never the Mac's `storage_full`. */
export const PAGES_FULL = {
  error: 'pages_full',
  message: 'The relay has no room for more pages. Delete some old pages, then publish again.',
} as const
