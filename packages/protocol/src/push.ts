import { z } from 'zod'
import { CardId, DeviceId, IsoTs, ThreadId } from './ids.ts'

export const PushPayload = z.object({
  web_push: z.literal(8030), // Declarative Web Push (iOS 18.4+); the SW path parses the same JSON
  notification: z.object({
    title: z.string().max(40), // agent name from config, e.g. "Talos"
    body: z.string().max(80), // fixed templates only
    navigate: z.string().startsWith('/'), // in-scope deep link
    tag: z.string().max(64).optional(),
    /** Alert again even though a notification with this `tag` may still be showing (web push `renotify`). Only the card-expiry reminder sets it: it shares its card's tag. */
    renotify: z.boolean().optional(),
    app_badge: z.number().int().optional(),
    silent: z.literal(false),
  }),
  talos: z.object({
    v: z.literal(1),
    kind: z.enum(['reply', 'card', 'digest', 'voice_result', 'system']),
    thread_id: ThreadId.optional(),
    card_id: CardId.optional(),
  }),
})
export type PushPayloadT = z.infer<typeof PushPayload>

export type PushTemplate =
  | 'reply' // New reply in {thread}
  | 'needs_you' // Needs you in {thread}
  | 'answer_ready' // Answer ready in {thread}
  | 'overnight' // Overnight: {n} items
  | 'session_stopped' // {agent}'s Mac session stopped
  | 'device_pinned' // New device pinned
  | 'bridge_key' // Your bridge key may be in use somewhere else
  | 'sign_in' // New sign-in to Talos
  | 'sign_in_unproven' // A sign-in named a device without proving it holds the key
  | 'storage_full' // The relay's storage is nearly full
  | 'schedule_failed' // A scheduled job failed (never names the job; docs/SCHEDULES.md S2.2)
  | 'scheduler_stuck' // Your scheduler needs you
  // Health alarms (docs/V2-FEATURES.md V1.3, V2.3); all navigate to /settings/health
  | 'mod_quiet' // {agent}'s mod stopped reporting
  | 'mac_back' // {agent}'s Mac is back
  | 'disk_low' // {agent}'s Mac disk is nearly full (docs/HEALTH.md)
  // Relay-sent: the relay drops what the Mac has not passed to the agent at 7 days; this is the day-6 warning. Not a Mac phrase.
  // Relay-sent: the relay told the phone a notification button worked, then the Mac refused it.
  | 'action_failed' // A tap on a notification did not go through
  | 'messages_waiting' // Messages for {agent}'s Mac will be dropped soon
  // Never-miss (owner calls O2, O7): both are fixed text. Neither can carry a title, a name or a message.
  | 'card_expiring' // A card in {thread} is about to expire (sent once, about an hour before). A needs-you push for per-thread rules.
  | 'quiet_summary' // What the quiet window held back: "3 replies, 1 card waiting". Counts only.

const PUSH_TEMPLATE_FLAGS: Record<PushTemplate, true> = {
  reply: true,
  needs_you: true,
  answer_ready: true,
  overnight: true,
  session_stopped: true,
  device_pinned: true,
  bridge_key: true,
  sign_in: true,
  sign_in_unproven: true,
  storage_full: true,
  schedule_failed: true,
  scheduler_stuck: true,
  mod_quiet: true,
  mac_back: true,
  disk_low: true,
  action_failed: true,
  messages_waiting: true,
  card_expiring: true,
  quiet_summary: true,
}
/** Every push template, in one list. The record above fails to compile when a template is added to the type and not here. */
export const PUSH_TEMPLATES = Object.keys(PUSH_TEMPLATE_FLAGS) as PushTemplate[]

/** Templates that open Settings -> Health. `session_stopped` gets the same deep link (docs/V2-FEATURES.md V1.3). */
export const HEALTH_TEMPLATES = ['session_stopped', 'mod_quiet', 'mac_back', 'disk_low'] as const
/** Mac-side health templates: they respect the quiet window and are rate-limited (V2.3 rule 5). */
export const MAC_SIDE_HEALTH_TEMPLATES = ['session_stopped', 'mod_quiet', 'mac_back', 'disk_low'] as const

/**
 * What the relay wants to tell the owner. Deliberately has NO free-text field: message text, card titles, senders
 * and subjects cannot reach a push payload because there is nowhere to put them.
 */
export type PushIntent = {
  template: PushTemplate
  thread_id?: string
  card_id?: string
  /** Item count for `overnight`. */
  count?: number
  /** `quiet_summary` only: how many replies the quiet window held back. A number, never a name or text. */
  replies?: number
  /** `quiet_summary` only: how many cards are still waiting from the quiet window. A number, never a title. */
  cards?: number
  app_badge?: number
  /** A card's own expiry. It never reaches the payload; it only caps how long the transport keeps the push (`pushTtlSeconds`). */
  expires_at?: string
}

/** The slice of AgentConfig that push needs. */
export type PushConfig = {
  agent: { name: string }
  notifications: { show_thread_names: 'fixed_only' | 'all' | 'none' }
  threads: ReadonlyArray<{ id: string; name: string; kind: 'fixed' | 'agent' | 'system' }>
}

function threadLabel(intent: PushIntent, config: PushConfig): string {
  const t = intent.thread_id ? config.threads.find((x) => x.id === intent.thread_id) : undefined
  if (!t) return 'a thread'
  const mode = config.notifications.show_thread_names
  // Agent-created thread names can carry content, so they show as "a thread" unless the owner chose 'all'.
  if (mode === 'all' || (mode === 'fixed_only' && t.kind !== 'agent')) return t.name
  return 'a thread'
}

/**
 * How long a push may wait for a device that is offline or asleep, and how urgently it is delivered. A card push is the
 * one that waits on the owner (`needs_you`, kind `card`): it goes out with high urgency and keeps for a day. Everything
 * else is a heads-up that is stale within the hour, except a digest (the overnight items, the wake-up summary after the quiet
 * window): it is sent once and settled, so a phone that was offline when it went out still gets it, for 12 hours. Both transports pick from the payload, so a template cannot get one
 * without the other. (How long a card itself lives is the owner's call, O2; this only keeps the push from dying first.)
 */
export const PUSH_TTL_S = { normal: 3600, card: 86_400, digest: 43_200 } as const
export function pushIsCard(p: Pick<PushPayloadT, 'talos'>): boolean {
  return p.talos.kind === 'card'
}
export function pushTtlSeconds(p: Pick<PushPayloadT, 'talos'>, secondsLeft?: number): number {
  const base = pushIsCard(p) ? PUSH_TTL_S.card : p.talos.kind === 'digest' ? PUSH_TTL_S.digest : PUSH_TTL_S.normal
  // A push must not outlive the card it is about: a phone that was out of signal for hours would otherwise get a
  // time-sensitive "Needs you" for a card that is long gone. Only a card push is capped; 0 means "now or never".
  if (!pushIsCard(p) || secondsLeft === undefined || !Number.isFinite(secondsLeft)) return base
  return Math.max(0, Math.min(base, Math.floor(secondsLeft)))
}
/** Seconds from `nowMs` until an ISO instant, or undefined when it is missing or unreadable. */
export function secondsUntil(iso: string | undefined, nowMs: number): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? (t - nowMs) / 1000 : undefined
}
export function pushUrgency(p: Pick<PushPayloadT, 'talos'>): 'high' | 'normal' {
  return pushIsCard(p) ? 'high' : 'normal'
}

/** "3 replies, 1 card waiting". Counts only: the numbers are clamped to whole, non-negative values. */
export function quietSummaryBody(replies?: number, cards?: number): string {
  const n = (v: number | undefined) => Math.max(0, Math.trunc(Number(v ?? 0))) || 0
  const r = n(replies)
  const c = n(cards)
  const parts: string[] = []
  if (r > 0) parts.push(`${r} ${r === 1 ? 'reply' : 'replies'}`)
  if (c > 0) parts.push(`${c} ${c === 1 ? 'card' : 'cards'} waiting`)
  return parts.length > 0 ? parts.join(', ') : 'Nothing new'
}

/** How a push is judged "needs you" for per-thread rules: the approval itself and its single expiry reminder. */
export function isNeedsYouTemplate(t: PushTemplate): boolean {
  return t === 'needs_you' || t === 'card_expiring'
}

/** The slice of a card the app badge looks at. */
export type BadgeCard = { state: string; expires_at: string; thread_id: string }
/** The slice of a thread the app badge looks at. */
export type BadgeThread = { id: string; archived?: boolean; notify?: string }

/**
 * The number on the app icon, on the relay (in each push) and on the phone and web app (between pushes). One function so
 * they cannot disagree: open (pending, unexpired) cards plus unread messages. Unread leaves out archived threads and threads
 * whose notifications are off; open cards are never left out, because a card waits on the owner whatever the thread's
 * notify setting (Home still lists it under Needs you, and a card pushed from an archived thread must count). (Owner call O21. To go back to open
 * cards only, make the `unread` sum below 0; nothing else needs to change.)
 */
export function badgeCount(
  s: {
    cards: ReadonlyArray<BadgeCard>
    unread: Readonly<Record<string, number>>
    threads: ReadonlyArray<BadgeThread>
  },
  nowMs: number,
): number {
  const quiet = new Set(s.threads.filter((t) => t.archived === true || t.notify === 'off').map((t) => t.id))
  const cards = s.cards.filter((c) => c.state === 'pending' && Date.parse(c.expires_at) > nowMs).length
  let unread = 0
  for (const [id, n] of Object.entries(s.unread)) if (!quiet.has(id) && n > 0) unread += n
  return cards + unread
}

export function buildPushPayload(intent: PushIntent, config: PushConfig): PushPayloadT {
  const agent = config.agent.name
  const thread = threadLabel(intent, config)
  const n = Math.max(0, Math.trunc(Number(intent.count ?? 0)))
  const T = {
    reply: { body: `New reply in ${thread}`, kind: 'reply' },
    needs_you: { body: `Needs you in ${thread}`, kind: 'card' },
    answer_ready: { body: `Answer ready in ${thread}`, kind: 'voice_result' },
    overnight: { body: `Overnight: ${n} items`, kind: 'digest' },
    session_stopped: { body: `${agent}'s Mac session stopped`, kind: 'system' },
    device_pinned: { body: 'New device pinned', kind: 'system' },
    bridge_key: { body: 'Your bridge key may be in use somewhere else', kind: 'system' },
    sign_in: { body: 'New sign-in to Talos', kind: 'system' },
    sign_in_unproven: { body: 'Sign-in on a device that did not prove its key', kind: 'system' },
    storage_full: { body: 'Relay storage is nearly full', kind: 'system' },
    schedule_failed: { body: 'A scheduled job failed', kind: 'system' },
    scheduler_stuck: { body: 'Your scheduler needs you', kind: 'system' },
    mod_quiet: { body: `${agent}'s mod stopped reporting`, kind: 'system' },
    mac_back: { body: `${agent}'s Mac is back`, kind: 'system' },
    disk_low: { body: `${agent}'s Mac disk is nearly full`, kind: 'system' },
    action_failed: { body: 'That tap did not go through. Open Talos to check.', kind: 'system' },
    messages_waiting: { body: `Your messages have not reached ${agent} yet. Wake its Mac today.`, kind: 'system' },
    card_expiring: { body: `A card in ${thread} expires soon`, kind: 'card' },
    quiet_summary: { body: quietSummaryBody(intent.replies, intent.cards), kind: 'digest' },
  } as const
  const entry = T[intent.template]
  const tid = intent.thread_id && ThreadId.safeParse(intent.thread_id).success ? intent.thread_id : undefined
  const cid = intent.card_id && CardId.safeParse(intent.card_id).success ? intent.card_id : undefined
  let navigate = '/'
  if (intent.template === 'schedule_failed' || intent.template === 'scheduler_stuck') navigate = '/schedules'
  else if ((HEALTH_TEMPLATES as readonly string[]).includes(intent.template)) navigate = '/settings/health'
  else if (intent.template === 'messages_waiting') navigate = '/settings/health'
  else if (intent.template === 'quiet_summary') navigate = '/'
  else if (entry.kind === 'digest') navigate = '/t/inbox'
  else if (cid) navigate = `/card/${cid}`
  else if (tid) navigate = `/t/${tid}`
  const notification: PushPayloadT['notification'] = {
    title: agent.slice(0, 40),
    body: entry.body.slice(0, 80),
    navigate,
    silent: false,
  }
  if (tid || cid) notification.tag = (cid ? `card:${cid}` : `thread:${tid}`).slice(0, 64)
  // The reminder shares its card's tag (so one card is one banner and a decided card clears it), and a notification that
  // replaces another with the same tag is silent unless it asks to renotify: the unseen first banner is the usual case.
  if (intent.template === 'card_expiring' && notification.tag) notification.renotify = true
  if (intent.app_badge !== undefined) notification.app_badge = Math.trunc(intent.app_badge)
  const talos: PushPayloadT['talos'] = { v: 1, kind: entry.kind }
  if (tid) talos.thread_id = tid
  if (cid) talos.card_id = cid
  return { web_push: 8030, notification, talos }
}

// ---- Native push (APNs, IOS-SPEC WP-I5) -------------------------------------------------------------------------------

export const APNS_ENVS = ['sandbox', 'production'] as const
export type ApnsEnvT = (typeof APNS_ENVS)[number]
/** A device token as the shell reports it: lowercase hex, 32 bytes today (Apple may lengthen it). */
export const ApnsToken = z.string().regex(/^[0-9a-f]{64,200}$/)
/** A signed registration may be at most this far from the relay's clock (and a nonce is remembered this long). */
export const APNS_REGISTRATION_SKEW_MS = 120_000

/**
 * What the app signs with its device key to register (or drop) its APNs token. Exact keys only: the signature covers
 * every field, `device_id` must be the session's pinned device, `ts` is fresh within two minutes and `nonce` is single
 * use. The relay never takes a token from an unsigned request.
 */
export const ApnsRegistration = z
  .strictObject({
    v: z.literal(1),
    type: z.literal('push.apns'),
    op: z.enum(['register', 'unregister']),
    device_id: DeviceId,
    token: ApnsToken.optional(),
    env: z.enum(APNS_ENVS).optional(),
    ts: IsoTs,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    osig: z.string().length(86),
  })
  .refine((r) => r.op === 'unregister' || (r.token !== undefined && r.env !== undefined), {
    message: 'register needs a token and an env',
  })
export type ApnsRegistrationT = z.infer<typeof ApnsRegistration>

/** `GET /api/push/apns`: the truth about native push, for Settings. Never a token, key or id of the key. */
export const ApnsStatus = z.object({
  /** The relay has a working APNs sender (all APNS_* variables present and the key parsed). */
  configured: z.boolean(),
  /** This session's device has a token registered. */
  registered: z.boolean(),
})
export type ApnsStatusT = z.infer<typeof ApnsStatus>

/** The two notification categories the iPhone app registers. Open / Approve both open the app; Approve opens the card armed (its normal Approve flow, Face ID first for a high-risk card), neither approves by itself. */
export const APNS_CATEGORIES = { open: 'TALOS_OPEN', card: 'TALOS_CARD' } as const

/**
 * The APNs request body for a payload built by `buildPushPayload`. It carries nothing the web payload does not: the
 * fixed title and body, a badge count, a category and the opaque in-app path and ids. Message text, card titles, senders
 * and subjects have no path into it (property-tested).
 */
export function buildApnsBody(
  p: PushPayloadT,
  opts: { openOnly?: boolean } = {},
): {
  aps: {
    alert: { title: string; body: string }
    badge?: number
    sound: 'default'
    category: string
    'thread-id'?: string
    /** Cards only: breaks through Focus and Scheduled Summary. Needs the time-sensitive entitlement (AppPush.entitlements); without it iOS treats the push as `active`. */
    'interruption-level'?: 'time-sensitive'
  }
  talos: PushPayloadT['talos'] & { navigate: string }
} {
  const n = p.notification
  const aps: ReturnType<typeof buildApnsBody>['aps'] = {
    alert: { title: n.title, body: n.body },
    sound: 'default',
    // `openOnly`: a card the owner can only deny (a permission card with no Allow) is not offered an Approve button.
    category:
      p.talos.kind === 'card' && p.talos.card_id && !opts.openOnly ? APNS_CATEGORIES.card : APNS_CATEGORIES.open,
  }
  if (n.app_badge !== undefined) aps.badge = Math.max(0, n.app_badge)
  if (n.tag) aps['thread-id'] = n.tag
  if (pushIsCard(p)) aps['interruption-level'] = 'time-sensitive'
  return { aps, talos: { ...p.talos, navigate: n.navigate } }
}
