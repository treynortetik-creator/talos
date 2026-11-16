// Push: a fixed-template payload sent over a PushTransport to every subscription (Apple, and the browser vendors, never get message text; a phone that turned text on also gets a sealed copy, built here from the plain text, so this relay can read it), subject to the
// owner's rules: nothing while someone is at a visible app socket (visible AND active within 60 s; `needs_you` ignores that), nothing in the quiet window, per-thread notify settings, master
// switch. Transports: Web Push now (`web-push`), a no-op sink until VAPID keys are set, APNs in Phase 2 (spec 14).

import https from 'node:https'
import type { AgentConfigT } from '@talos-app/protocol'
import {
  badgeCount,
  buildPushPayload,
  grantScopes,
  isBlockedHost,
  isBlockedHostname,
  isNeedsYouTemplate,
  isQuiet,
  NativeGrant,
  noticeSubtitle,
  type PushIntent,
  type PushPayloadT,
  pushTtlSeconds,
  pushUrgency,
  type RichContentT,
  richContentFor,
  type SealEnvelopeT,
  sealPush,
  secondsUntil,
} from '@talos-app/protocol'
import { checkedLookup } from '@talos-app/protocol/guarded-fetch'
import webpush from 'web-push'
import type { Clock, Logger, PushService, PushTransport, RichPushInput } from '../services.ts'
import type { NtfySink } from './alerts-ntfy.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import type { ApnsSender } from './push-apns.ts'
import { holdForSummary } from './quiet-summary.ts'
import type { PushSub, Store } from './store.ts'

export class NoopTransport implements PushTransport {
  readonly name = 'webpush' as const
  readonly sent: Array<{ endpoint: string; payload: PushPayloadT }> = []
  readonly opts: Array<{ secondsLeft?: number } | undefined> = []
  async send(sub: PushSub, payload: PushPayloadT, opts?: { secondsLeft?: number }) {
    this.sent.push({ endpoint: sub.endpoint, payload })
    this.opts.push(opts)
    return { ok: true, gone: false }
  }
}

/**
 * The longest the relay waits for any one send, web or Apple, whatever the transport does with its own timeout: a send that
 * never settles must not hold its caller (the card reminder and the quiet summary run one tick at a time). Past it the send
 * counts as refused, so a caller that retries tries again. Above APNs's own budget (a 3 s ping, a 10 s connect and a 10 s
 * request), so a slow send Apple still delivers is not counted as refused.
 */
export const PUSH_SEND_DEADLINE_MS = 30_000

/** How long one browser push may take. A push service answers in well under a second; a host that never answers must not hold the send open. */
export const WEB_PUSH_TIMEOUT_MS = 15_000

/**
 * A browser's push endpoint is a URL the browser hands over, and the relay then POSTs to it on every notification from
 * inside its own network. A real push service is a public https host, so anything else is refused: another scheme, a
 * `user:pass@`, an address literal that is not public (loopback, private, link-local, the cloud metadata address and the
 * IPv6 forms that carry one), and a name that is never public (`localhost`, `*.internal`, `*.local`, a single label).
 */
export function pushEndpointAllowed(endpoint: string): boolean {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  return !isBlockedHost(u.hostname) && !isBlockedHostname(u.hostname)
}

export function createWebPushTransport(
  vapid: { publicKey: string; privateKey: string; subject: string },
  /** Tests: how a host name is resolved. The connection only ever goes to an address this lookup just approved. */
  opts: { resolve?: (host: string) => Promise<readonly string[]> } = {},
): PushTransport {
  // The name is resolved once, by a lookup that refuses any address that is not public, and the socket connects to the
  // address that passed: a name that points inward (or is re-pointed after it was stored) is never contacted.
  const agent = new https.Agent({ lookup: checkedLookup(opts.resolve ? { resolve: opts.resolve } : {}) as never })
  return {
    name: 'webpush',
    async send(sub, payload, sendOpts) {
      // A row stored before the endpoint was checked can never be sent to: drop it.
      if (!pushEndpointAllowed(sub.endpoint)) return { ok: false, gone: true }
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), {
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          // Picked from the payload so no caller can forget: a card push is urgent and keeps for a day (PUSH_TTL_S).
          TTL: pushTtlSeconds(payload, sendOpts?.secondsLeft),
          urgency: pushUrgency(payload),
          agent,
          timeout: WEB_PUSH_TIMEOUT_MS,
        })
        return { ok: true, gone: false }
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        return { ok: false, gone: status === 404 || status === 410 }
      }
    },
  }
}

/**
 * Templates that are not about chat content and so ignore the quiet window and per-thread settings. The Mac-side health
 * templates (`session_stopped`, `mod_quiet`, `mac_back`) are NOT here: they respect the quiet window (V2.3 rule 5).
 */
const SYSTEM_TEMPLATES = new Set<PushIntent['template']>([
  'device_pinned',
  'bridge_key',
  'bridge_takeover',
  'sign_in',
  'sign_in_unproven',
  'storage_full',
  'messages_waiting',
  'action_failed',
  'settings_changed',
  'sent_always_allowed',
])

/**
 * Security alerts are the owner's only warning that someone signed in (or that a device signed in without proving its key), or
 * that another Mac took the bridge. Like the health templates they ignore the master switch and a visible socket: a tab open on
 * the Mac, or a socket an attacker keeps open with a made-up "visible" hello, must not swallow them. They stay out of ntfy and
 * HEALTH_PUSH.
 */
const SIGN_IN_ALERTS = new Set<PushIntent['template']>(['sign_in', 'sign_in_unproven', 'bridge_takeover'])

/**
 * The agent changed a setting that decides which alerts reach the owner (packages/protocol push.ts). Like a sign-in alert it
 * ignores the master switch and a visible socket, and like a system template the quiet window and thread alerts: a change that
 * silences him is never itself silenced.
 */
const ALERTS_CHANGED = new Set<PushIntent['template']>(['settings_changed', 'sent_always_allowed'])

/** Health templates ignore a visible socket (a desktop tab nobody watches must not swallow the phone push) and go to ntfy. */
const HEALTH_PUSH = new Set<PushIntent['template']>([
  'session_stopped',
  'mod_quiet',
  'mac_back',
  'storage_full',
  'disk_low',
  'messages_waiting',
])

export const TEST_ALERT_TEXT = 'Test alert from Talos'

export type PushDeps = {
  store: Store
  clock: Clock
  log: Logger
  transport: PushTransport
  config: () => AgentConfigT | null
  anyVisible: () => boolean
  /** Optional ntfy topic (ALERT_NTFY_URL). Health templates are mirrored to it. */
  ntfy?: NtfySink | null
  /** Native iPhone push. Null/absent until the APNS_* variables are set; then devices registered by the app get it too. */
  apns?: ApnsSender | null
}

/** What the test button reports: pushes attempted / accepted, and ntfy's part. */
export type TestResult = { push: { sent: number; ok: number }; ntfy: 'off' | 'sent' | 'failed' }

/** Pushes attempted and accepted, with the native (APNs) share on its own. */
/**
 * What one push did: sends attempted and accepted (web and Apple), the native share, how many of the refused ones only ran
 * out of time (the service may still have delivered them), and, for a health push, whether ntfy took it.
 */
export type PushCounts = {
  sent: number
  ok: number
  native: { sent: number; ok: number }
  timedOut?: number
  ntfy?: boolean
}

export type PushOutcome = { last_ok_at: number | null; last_error_at: number | null }

/** The only threads whose names may travel to Apple: the two built in. Everything else is something a person or an agent named. */
const APPLE_SAFE_THREADS = new Set(['general', 'inbox'])
/** The words Apple may see for the two built-in threads and for the agent. Never the configured names: General can be renamed and an agent is named by its owner. */
const APPLE_THREAD_WORDS: Record<string, string> = { general: 'General', inbox: 'Inbox' }
const APPLE_TITLE = 'Talos'

/**
 * The config the APNs payload is BUILT with. An APNs request is TLS to Apple only (web push is encrypted to the browser), so
 * what it carries is readable by Apple, whatever "Show thread names" says (that setting governs web push only). Every thread
 * except the built-in General and Inbox is made to read as the fixed phrase "a thread".
 */
export function appleConfig(cfg: AgentConfigT): AgentConfigT {
  return {
    ...cfg,
    agent: { ...cfg.agent, name: APPLE_TITLE },
    notifications: { ...cfg.notifications, show_thread_names: 'fixed_only' },
    threads: cfg.threads.map((t) =>
      APPLE_SAFE_THREADS.has(t.id)
        ? { ...t, name: APPLE_THREAD_WORDS[t.id] ?? t.id, kind: 'fixed' as const }
        : { ...t, kind: 'agent' as const },
    ),
  }
}

/**
 * The payload as Apple may see it. A thread id is slugified from its name ("Severance talks with Bob" ->
 * severance_talks_with_bob), so for any thread but General and Inbox the id, its tag, the deep link and the collapse id are
 * replaced by an opaque, relay-minted reference; the app resolves it after the tap over its authenticated connection
 * (`/open/<ref>`). A card keeps its own deep link: card ids are random ULIDs.
 */
export function forApple(p: PushPayloadT, mintRef: (threadId: string) => string): PushPayloadT {
  const tid = p.talos.thread_id
  if (!tid || APPLE_SAFE_THREADS.has(tid)) return p
  const { thread_id: _drop, ...talos } = p.talos
  const { tag, navigate, ...n } = p.notification
  if (talos.card_id) return { ...p, notification: { ...n, navigate, ...(tag ? { tag } : {}) }, talos }
  const ref = mintRef(tid)
  return { ...p, notification: { ...n, navigate: `/open/${ref}`, tag: `thread:${ref}` }, talos }
}

export class CorePush implements PushService {
  private lastOk: number | null = null
  private lastError: number | null = null

  constructor(private d: PushDeps) {}

  /** When Web Push last worked and last failed (this process only; the Health screen shows them). */
  outcome(): PushOutcome {
    return { last_ok_at: this.lastOk, last_error_at: this.lastError }
  }

  get hasNtfy(): boolean {
    return Boolean(this.d.ntfy)
  }

  /**
   * Decides whether to send; `force` skips the rules (the settings screen's "test notification"). `fromHealth` marks a
   * call from the health watchdog: the hub's own 5-minute `session_stopped` alarm is ignored (the watchdog owns that
   * alert: once per outage, rate-limited, quiet-window aware).
   */
  /** Sends `intent` by the owner's rules; says what happened, like notifyCounted, for a caller that wants to know. */
  async notify(
    intent: PushIntent,
    opts: { force?: boolean; fromHealth?: boolean; rich?: RichPushInput } = {},
  ): Promise<PushCounts | null> {
    return this.run(intent, opts)
  }

  /** Like `notify`, but says what happened: how many pushes were attempted and accepted (null = the rules held it back). */
  async notifyCounted(
    intent: PushIntent,
    opts: { force?: boolean; fromHealth?: boolean; rich?: RichPushInput } = {},
  ): Promise<PushCounts | null> {
    return this.run(intent, opts)
  }

  private async run(
    intent: PushIntent,
    opts: { force?: boolean; fromHealth?: boolean; rich?: RichPushInput },
  ): Promise<PushCounts | null> {
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    if (intent.template === 'session_stopped' && !opts.fromHealth && !opts.force) {
      this.skip(intent, 'health_owned')
      return null
    }
    const health = HEALTH_PUSH.has(intent.template)
    const alwaysOn = health || SIGN_IN_ALERTS.has(intent.template) || ALERTS_CHANGED.has(intent.template)
    if (!opts.force) {
      // health alarms are not chat notifications: the master switch silences chat, never "your Mac died" (and ntfy)
      if (!cfg.notifications.master && !alwaysOn) {
        this.skip(intent, 'master_off')
        return null
      }
      // `needs_you` is exempt from the visible-socket rule: a card waits on the owner, and a desktop window nobody is
      // reading (a tab left open on the Mac) must never swallow the push to the phone. `action_failed` is the same: the tap came
      // from a notification button, the phone may be locked, and a visible socket on another screen is not the owner reading it. A reply or a digest stays quiet
      // while someone is looking. The quiet window and the master switch still apply to it (quiet is owner call O7).
      // `card_expiring`, the one reminder before a card dies, is a needs-you push in every one of these rules.
      if (
        !alwaysOn &&
        !isNeedsYouTemplate(intent.template) &&
        intent.template !== 'action_failed' &&
        this.d.anyVisible()
      ) {
        this.skip(intent, 'visible')
        return null
      }
      if (!SYSTEM_TEMPLATES.has(intent.template)) {
        if (isQuiet(new Date(this.d.clock.now()), cfg.quiet_window, cfg.timezone)) {
          // Not lost: counted, and told as one summary when the window ends (core/quiet-summary.ts, owner call O7).
          try {
            holdForSummary(this.d.store, intent, cfg)
          } catch {
            this.d.log.error({ template: intent.template }, 'quiet count failed')
          }
          this.skip(intent, 'quiet')
          return null
        }
        const thread = intent.thread_id ? cfg.threads.find((t) => t.id === intent.thread_id) : undefined
        if (thread?.notify === 'off') {
          this.skip(intent, 'thread_off')
          return null
        }
        if (thread?.notify === 'needs_you' && !isNeedsYouTemplate(intent.template)) {
          this.skip(intent, 'thread_needs_you')
          return null
        }
      }
    }
    const badge = this.badge(cfg)
    const payload = buildPushPayload({ app_badge: badge, ...intent }, cfg)
    const ntfy =
      health && this.d.ntfy ? await this.d.ntfy.send(payload.notification.body, payload.notification.title) : undefined
    const apple = forApple(buildPushPayload({ app_badge: badge, ...intent }, appleConfig(cfg)), (tid) =>
      this.d.store.pushRef(tid),
    )
    const counts = await this.deliver(
      intent,
      payload,
      apple,
      opts.rich ? this.richFor(intent, cfg, payload, opts.rich) : undefined,
      opts.rich?.openOnly === true,
    )
    return ntfy === undefined ? counts : { ...counts, ntfy }
  }

  /**
   * The readable content for phones that hold a grant, with the thread's real name as the subtitle (only inside the seal,
   * and only as far as "Show thread names" allows). Null when the push is not one that carries text.
   */
  private richFor(
    intent: PushIntent,
    cfg: AgentConfigT,
    payload: PushPayloadT,
    rich: RichPushInput,
  ): RichContentT | null {
    const kind = payload.talos.kind
    if (kind !== 'reply' && kind !== 'card') return null
    const subtitle = noticeSubtitle(intent.thread_id, cfg)
    try {
      return richContentFor({
        kind,
        text: rich.text,
        ...(subtitle ? { subtitle } : {}),
        ...(intent.thread_id ? { threadId: intent.thread_id } : {}),
        ...(rich.card ? { card: rich.card } : {}),
      })
    } catch {
      return null
    }
  }

  /** One seal for one phone, or null (no grant, a grant that is not current, a key that will not seal): that phone gets the template. */
  private async sealFor(
    deviceId: string,
    apple: PushPayloadT,
    content: RichContentT,
  ): Promise<{ seal: SealEnvelopeT; grantJson: string } | null> {
    try {
      const g = this.d.store.nativeGrant(deviceId)
      if (!g) return null
      const parsed = NativeGrant.safeParse(JSON.parse(g.grantJson))
      if (!parsed.success || grantScopes(parsed.data).length === 0) return null
      const seal = await sealPush({
        encPub: g.encPub,
        deviceId,
        kind: apple.talos.kind,
        cardId: apple.talos.card_id,
        content,
      })
      return { seal, grantJson: g.grantJson }
    } catch {
      this.d.log.error({ via: 'apns' }, 'push seal failed; sending the fixed template')
      return null
    }
  }

  /**
   * The number on the app icon: open cards plus unread, leaving out archived threads and threads set to off (owner call
   * O21). The same function the phone and the web app use between pushes, so the icon never jumps when a push lands.
   */
  private badge(cfg: AgentConfigT): number {
    const now = this.d.clock.now()
    return badgeCount(
      { cards: this.d.store.openCards(now), unread: this.d.store.unreadByThread(), threads: cfg.threads },
      now,
    )
  }

  /**
   * The Health screen's "Send test alert": one fixed test message down every configured path, whatever the rules say,
   * and the truth about what happened: how many pushes were attempted and accepted, and whether ntfy took it.
   */
  async sendTest(): Promise<TestResult> {
    const cfg = this.d.config() ?? DEFAULT_AGENT_CONFIG
    const base = buildPushPayload({ template: 'mac_back' }, cfg)
    const payload: PushPayloadT = {
      ...base,
      notification: { ...base.notification, body: TEST_ALERT_TEXT, navigate: '/settings/health', tag: 'health-test' },
    }
    const ntfy = this.d.ntfy
      ? (await this.d.ntfy.send(TEST_ALERT_TEXT, payload.notification.title))
        ? 'sent'
        : 'failed'
      : 'off'
    const appleBase = buildPushPayload({ template: 'mac_back' }, appleConfig(cfg))
    const apple: PushPayloadT = {
      ...appleBase,
      notification: {
        ...appleBase.notification,
        body: TEST_ALERT_TEXT,
        navigate: '/settings/health',
        tag: 'health-test',
      },
    }
    const r = await this.deliver({ template: 'mac_back' }, payload, apple)
    return { push: { sent: r.sent, ok: r.ok }, ntfy }
  }

  /** True when native push can send (a working key). Settings reads this through `/api/push/apns`. */
  get apnsConfigured(): boolean {
    return Boolean(this.d.apns)
  }

  /** `send()`'s answer, or `fallback` when it throws or has not settled within PUSH_SEND_DEADLINE_MS (on the relay's clock). */
  private withinDeadline<T>(send: () => Promise<T> | T, fallback: T, onTimeout?: () => void): Promise<T> {
    let sending: Promise<T>
    try {
      sending = Promise.resolve(send())
    } catch {
      return Promise.resolve(fallback)
    }
    return new Promise<T>((resolve) => {
      let done = false
      let timer: unknown = null
      const settle = (v: T) => {
        if (done) return
        done = true
        if (timer !== null) this.d.clock.clearTimeout(timer)
        resolve(v)
      }
      sending.then(settle, () => settle(fallback))
      // Armed a microtask later, so a send that answers at once never meets its deadline: a test clock fires the timers that
      // fall due while it moves synchronously, before any answer can arrive. A real timer never fires that soon anyway.
      queueMicrotask(() => {
        if (done) return
        timer = this.d.clock.setTimeout(() => {
          if (done) return
          done = true
          this.d.log.error({ after_ms: PUSH_SEND_DEADLINE_MS }, 'push send timed out')
          onTimeout?.()
          resolve(fallback)
        }, PUSH_SEND_DEADLINE_MS)
      })
    })
  }

  private async deliver(
    intent: PushIntent,
    payload: PushPayloadT,
    applePayload: PushPayloadT,
    rich?: RichContentT | null,
    openOnly = false,
  ): Promise<PushCounts> {
    let unreadableSubs = 0
    let timedOut = 0
    const late = () => void timedOut++
    let subs: PushSub[] = []
    try {
      subs = this.d.store.listSubs(() => {
        unreadableSubs++
      })
    } catch {
      unreadableSubs++
    }
    if (unreadableSubs > 0)
      this.d.log.error({ template: intent.template, unreadable: unreadableSubs }, 'web push rows unreadable')
    // a card's time to live is on the relay's clock (store.putCard shifts it by the Mac's measured offset)
    const relayExpiry = intent.card_id ? this.cardExpiry(intent.card_id) : null
    const secondsLeft =
      relayExpiry !== null
        ? (relayExpiry - this.d.clock.now()) / 1000
        : secondsUntil(intent.expires_at, this.d.clock.now())
    // A store error here (a row that no longer decrypts) must not take web push down with it.
    // When native push is on and the list cannot be read (a locked database, a row that no longer decrypts), that is one
    // attempted, failed send: callers that retry must see it, and "nobody to notify" would be a lie.
    let devices: ReturnType<Store['listPushDevices']> = []
    let unreadable = 0
    if (this.d.apns) {
      try {
        devices = this.d.store.listPushDevices(() => {
          unreadable++
        })
      } catch {
        unreadable++
      }
      if (unreadable > 0) this.d.log.error({ template: intent.template, unreadable }, 'push devices unreadable')
    }
    if (subs.length === 0 && devices.length === 0 && unreadable === 0 && unreadableSubs === 0) {
      this.skip(intent, 'no_subscription')
      return { sent: 0, ok: 0, native: { sent: 0, ok: 0 } }
    }
    // Native and web run side by side: a slow or hung APNs must never hold a browser's push back (review M5). Both always
    // go: the Home Screen web app and the native app are separate devices to the relay (review H4: no dedupe).
    const native = Promise.all(
      devices.map(async (dev) => {
        const sealed = rich ? await this.sealFor(dev.deviceId, applePayload, rich) : null
        // Sealing waits, and so does the connection to Apple, and a revoke can land in either. The sender asks this right
        // before each request leaves (the first and the retry): a device the Mac no longer trusts gets nothing; a seal made
        // for a grant that has since been replaced, revoked or has run out is dropped, so that phone gets the fixed
        // template and no message text. A store error here is a failed send (the owner's reminder logic must see it),
        // never "nobody to notify".
        const gate = (): 'seal' | 'template' | 'none' => {
          try {
            if (!this.d.store.pushDeviceLive(dev.deviceId)) return 'none'
          } catch (e) {
            this.d.log.error({ template: intent.template, via: 'apns' }, 'push recheck failed; not sending')
            throw e
          }
          if (!sealed) return 'template'
          try {
            return this.d.store.nativeGrant(dev.deviceId)?.grantJson === sealed.grantJson ? 'seal' : 'template'
          } catch {
            this.d.log.error(
              { template: intent.template, via: 'apns' },
              'grant recheck failed; sending the fixed template',
            )
            return 'template'
          }
        }
        const res = (await this.withinDeadline(
          () =>
            this.d.apns?.send(dev, applePayload, {
              secondsLeft,
              ...(sealed ? { seal: sealed.seal } : {}),
              ...(openOnly ? { openOnly } : {}),
              gate,
            }) ?? null,
          null,
          late,
        )) ?? {
          ok: false,
          gone: false,
        }
        if (res.skipped) {
          this.d.log.info({ template: intent.template, via: 'apns' }, 'push skipped: device no longer trusted')
          return null
        }
        this.record(res.ok)
        // Only Apple's 410 deletes a token. A 400 (BadDeviceToken, DeviceTokenNotForTopic) can be a wrong host or a
        // mistyped APNS_BUNDLE_ID, and deleting would turn a config typo into a silent permanent off (review M2).
        if (res.gone) this.d.store.deletePushDeviceByToken(dev.token)
        this.d.log.info({ template: intent.template, via: 'apns', ok: res.ok, gone: res.gone }, 'push sent')
        return res.ok
      }),
    )
    const web = Promise.all(
      subs.map(async (sub) => {
        const res = await this.withinDeadline(
          () => this.d.transport.send(sub, payload, { secondsLeft }),
          { ok: false, gone: false },
          late,
        )
        this.record(res.ok)
        if (res.gone) this.d.store.deleteSub(sub.endpoint)
        this.d.log.info({ template: intent.template, ok: res.ok, gone: res.gone }, 'push sent')
        return res.ok
      }),
    )
    const nativeResults = (await native).filter((r): r is boolean => r !== null)
    if (unreadable > 0) nativeResults.push(false)
    const results = [...nativeResults, ...(await web), ...Array<boolean>(unreadableSubs).fill(false)]
    return {
      sent: results.length,
      ok: results.filter(Boolean).length,
      native: { sent: nativeResults.length, ok: nativeResults.filter(Boolean).length },
      timedOut,
    }
  }

  private cardExpiry(id: string): number | null {
    try {
      return this.d.store.cardExpiresAt(id)
    } catch {
      return null
    }
  }

  private record(ok: boolean) {
    if (ok) this.lastOk = this.d.clock.now()
    else this.lastError = this.d.clock.now()
  }

  private skip(intent: PushIntent, reason: string) {
    this.d.log.debug({ template: intent.template, reason }, 'push skipped')
  }
}
