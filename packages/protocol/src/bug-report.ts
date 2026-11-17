// In-app bug reports. The owner presses Send on a screenshot and some context; the page signs the whole report with the
// device key (an owner frame, like `native.grant`) and posts it to the relay, which keeps it for 90 days and, when the
// owner has turned the webhook on, tells one URL that a report arrived. Nothing here carries a key or a token: the page
// removes those before it signs (same redaction as `talos-app report`), and the relay stores what it was given.

import { z } from 'zod'
import { isBlockedHost, isBlockedHostname } from './address.ts'
import { DeviceId, IsoTs, Ulid } from './ids.ts'
import { PROBLEM_LIMITS, ProblemDevice } from './problems.ts'
import { redact } from './redact.ts'

const KIB = 1024
const MIB = KIB * KIB

/** One list of every cap, so the page and the relay read the same numbers. */
/**
 * Whether `raw` is an address the relay may send bug reports to, by its text: https only (port 443 or 8443), no `user:pass@`, and no host that is
 * never public (an IP literal outside the public internet, `localhost`, `*.local`, `*.internal`, a single-label name). The
 * app's Settings and the relay ask this same question; the relay checks the address the name resolves to again when it
 * connects (bug-reports.ts `pinnedLookup`).
 */
export function bugWebhookUrlOk(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  // the https ports only: a POST aimed at a mail or database port of some public host is not a webhook
  if (u.port !== '' && u.port !== '443' && u.port !== '8443') return null
  if (isBlockedHost(u.hostname) || isBlockedHostname(u.hostname)) return null
  return u
}

/** Why a bug webhook address was refused, in the app's Settings and from the relay alike. */
export const BUG_WEBHOOK_URL_RULE =
  'Use an https address on the public internet (port 443 or 8443), with no user name or password in it, and not localhost or a local network name.'

export const BUG_REPORT_LIMITS = {
  /** The screenshot, after decoding. */
  imageBytes: 5 * MIB,
  /** The relay refuses a POST body larger than this: the image as base64 (4/3 of 5 MiB) plus the text, with room to spare. */
  bodyBytes: 8 * MIB,
  whatChars: 4000,
  expectedChars: 4000,
  logLines: 200,
  logChars: 60 * KIB,
  errors: 50,
  errorChars: 400,
  messages: 5,
  messageChars: 4000,
  /** The most disk all kept reports may use together (the relay's `BUG_REPORTS_MAX_MB` overrides it); a new one past it is refused with 507. */
  totalBytes: 500 * MIB,
  /** Reports one device may send, per rolling hour and per rolling day (relay bucket `bug_report`). */
  perHour: 6,
  perDay: 20,
  /** The relay deletes a report this many days after it arrived. */
  retentionDays: 90,
} as const

export const BugReportVersions = z.strictObject({
  app: z.string().max(40),
  bridge: z.string().max(40),
  relay: z.string().max(40),
  claude_code: z.string().max(40),
})

/** The text part of a report. Every field has a cap; nothing else can ride along (strict). */
export const BugReportBody = z.strictObject({
  what_went_wrong: z.string().min(1).max(BUG_REPORT_LIMITS.whatChars),
  expected: z.string().max(BUG_REPORT_LIMITS.expectedChars).optional(),
  versions: BugReportVersions,
  /** Which thread and screen the owner was on (ids and route names, not titles). */
  thread_id: z.string().max(80).optional(),
  screen: z.string().max(80).optional(),
  /** Which app sent it, from the shell's own marker (never the user agent text). Absent from an older app. */
  client: ProblemDevice.extract(['browser', 'mac_app', 'iphone_app']).optional(),
  /** The screens visited by name, oldest first, the last one being where it was sent from. Absent from an older app. */
  routes: z.array(z.string().max(PROBLEM_LIMITS.routeChars)).max(PROBLEM_LIMITS.routes).optional(),
  recent_errors: z.array(z.string().max(BUG_REPORT_LIMITS.errorChars)).max(BUG_REPORT_LIMITS.errors),
  /** The last 200 log lines, already cleaned. */
  logs: z.string().max(BUG_REPORT_LIMITS.logChars),
  /** Off unless the owner switched it on: the last 5 messages of the thread. */
  messages: z
    .array(z.strictObject({ role: z.enum(['you', 'agent']), text: z.string().max(BUG_REPORT_LIMITS.messageChars) }))
    .max(BUG_REPORT_LIMITS.messages)
    .optional(),
})
export type BugReportBodyT = z.infer<typeof BugReportBody>

export const BugReportImageType = z.enum(['image/png', 'image/jpeg'])

/**
 * What the page posts: the report and the picture in one object, signed by the device key (`signOwnerFrame`), so the
 * relay stores nothing the paired device did not sign. `image_b64` is standard base64 of a PNG or JPEG.
 */
export const BugReportPost = z.strictObject({
  v: z.literal(1),
  type: z.literal('bug.report'),
  device_id: DeviceId,
  id: Ulid,
  ts: IsoTs,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  report: BugReportBody,
  image_type: BugReportImageType,
  image_b64: z.string().min(1), // the relay's body cap bounds it; its size is judged after decoding (413)
  osig: z.string().length(86),
})
export type BugReportPostT = z.infer<typeof BugReportPost>

export const BugReportAck = z.object({ ok: z.literal(true), id: Ulid })

/** The picture in a webhook body: standard base64 of a PNG or JPEG, at most `imageBytes` once decoded. */
export const BugReportWebhookImage = z.object({
  type: BugReportImageType,
  b64: z
    .string()
    .min(1)
    .max(Math.ceil(BUG_REPORT_LIMITS.imageBytes / 3) * 4),
})

/**
 * The webhook body (Standard Webhooks). To an address the owner set: the report without the picture, which the relay keeps.
 * To the Talos team's inbox (`BUG_TEAM_INBOX_URL`): the picture too, in `image`, inside the one signed body.
 */
export const BugReportWebhook = z.object({
  type: z.literal('bug.reported'),
  timestamp: IsoTs,
  data: z.object({
    id: Ulid,
    device_id: DeviceId,
    image_bytes: z.number().int().nonnegative(),
    report: BugReportBody,
    image: BugReportWebhookImage.optional(),
  }),
})
export type BugReportWebhookT = z.infer<typeof BugReportWebhook>

/**
 * Where a new report goes after the relay keeps it, as the reporter tells the person sending it
 * (`GET /api/bug-reports/destination`). `relay`: nowhere else. `team`: the Talos team's inbox, which the person who deployed
 * this relay named in its environment (`BUG_TEAM_INBOX_URL`). `webhook`: the address the owner set in Settings, shown by its
 * host only (`shownWebhookHost`), never the address itself, which may carry a token.
 */
export const BugReportDestination = z.discriminatedUnion('to', [
  z.object({ to: z.literal('relay') }),
  z.object({ to: z.literal('team') }),
  z.object({ to: z.literal('webhook'), host: z.string().min(1).max(253) }),
])
export type BugReportDestinationT = z.infer<typeof BugReportDestination>

/**
 * A report's text run through `talos-app report`'s redaction (redact.ts), as the relay does before a report leaves for the
 * webhook. The app already cleaned it the same way; this is the second net, for whatever an app sent.
 */
export function redactReport(r: BugReportBodyT): BugReportBodyT {
  // redaction can lengthen a text (`k=a` becomes `k=[redacted]`): each is cut back to its limit, so the result still fits
  const R = (s: string, max: number) => redact(s).slice(0, max)
  const L = BUG_REPORT_LIMITS
  return {
    ...r,
    what_went_wrong: R(r.what_went_wrong, L.whatChars),
    ...(r.expected !== undefined ? { expected: R(r.expected, L.expectedChars) } : {}),
    recent_errors: r.recent_errors.map((e) => R(e, L.errorChars)),
    logs: R(r.logs, L.logChars),
    ...(r.messages ? { messages: r.messages.map((m) => ({ ...m, text: R(m.text, L.messageChars) })) } : {}),
  }
}

// ---- the bug inbox (the receiving end, on the Talos team's relay) ------------------------------------------------------

export const BUG_INBOX_LIMITS = {
  /** The whole signed body: the picture as base64 (4/3 of 5 MiB) and the text, with room to spare. */
  bodyBytes: BUG_REPORT_LIMITS.bodyBytes,
  /** How far `webhook-timestamp` may be from the inbox's clock, either way (Standard Webhooks' own default). */
  toleranceS: 5 * 60,
} as const

/**
 * What the inbox reads from a delivery. Bounded like the report itself, but not strict: a newer sender's extra field is
 * dropped, not a reason to lose the report. What the inbox does not name here (the device id aside) never reaches the Mac.
 */
export const BugInboxDelivery = z.object({
  type: z.literal('bug.reported'),
  timestamp: IsoTs,
  data: z.object({
    id: Ulid,
    device_id: DeviceId,
    report: z.object({
      what_went_wrong: z.string().min(1).max(BUG_REPORT_LIMITS.whatChars),
      expected: z.string().max(BUG_REPORT_LIMITS.expectedChars).optional(),
      versions: z
        .object({
          app: z.string().max(40).optional(),
          bridge: z.string().max(40).optional(),
          relay: z.string().max(40).optional(),
          claude_code: z.string().max(40).optional(),
        })
        .catch({}),
      thread_id: z.string().max(80).optional().catch(undefined),
      screen: z.string().max(80).optional().catch(undefined),
      client: ProblemDevice.extract(['browser', 'mac_app', 'iphone_app']).optional().catch(undefined),
      routes: z.array(z.string().max(PROBLEM_LIMITS.routeChars)).max(PROBLEM_LIMITS.routes).optional().catch(undefined),
      recent_errors: z.array(z.string().max(BUG_REPORT_LIMITS.errorChars)).max(BUG_REPORT_LIMITS.errors).catch([]),
      logs: z.string().max(BUG_REPORT_LIMITS.logChars).catch(''),
      messages: z
        .array(z.object({ role: z.enum(['you', 'agent']), text: z.string().max(BUG_REPORT_LIMITS.messageChars) }))
        .max(BUG_REPORT_LIMITS.messages)
        .optional()
        .catch(undefined),
    }),
    image: BugReportWebhookImage.optional(),
  }),
})
export type BugInboxDeliveryT = z.infer<typeof BugInboxDelivery>
