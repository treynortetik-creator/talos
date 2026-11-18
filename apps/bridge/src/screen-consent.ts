// Screen helper, lane 3: the owner's consent per app per Mac. A screen tool that hits an app off the Mac's allowed list gets an
// `ask` id from the Mac (which measured the app's id, team and code-signing requirement itself); this asks the Mac back for that
// measurement and puts ONE card to the owner per app per Mac: "Let your agent control <app> on this Mac?" Allow · Not now. The
// agent is answered at once in words and never waits. While a card for the app is open no other is made; "Not now" holds for an
// hour. On Allow the owner's own signed tap goes to the Mac on the screen socket (`allow`); the Mac checks the signature and the
// card's binding, and only then writes its list. This file never writes the list: Talos.app is its one writer.
//
// The card's kind is `config` (the bridge's own settings card), with a payload of its own: no app or relay change is needed to
// show or answer it, and it is never approvable from a notification (only a signed tap in the app carries the proof the Mac
// needs). Nothing a session sends names the app: the session hands over the Mac's opaque id, and the app on the card is what the
// Mac says it measured.
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import {
  bindingFrom,
  buildDialogProof,
  Card,
  type CardBinding,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  clipUnits,
  newId,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from './cards-ledger.ts'
import { type BridgeContext, defaultThreadRef } from './context.ts'
import { cardCreateFrame, cardUpdateFrame } from './frames-out.ts'
import { refusalText, type ScreenAnswer, screenTransport } from './screen.ts'
import { assertFrameFits } from './transport.ts'

/** "Not now" holds this long for that app on this Mac. */
export const SCREEN_NOT_NOW_MS = 3600_000
/** An unanswered card lives a day (the Mac takes a tap up to 25 hours old). */
export const SCREEN_CARD_EXPIRY_MS = 24 * 3600_000
const KEY = 'scr:'
/** At most this many consent cards wait at once, and this many are made in an hour, per Mac (review R1-5). */
export const SCREEN_MAX_PENDING = 3
export const SCREEN_MAX_PER_HOUR = 10
const HOUR_KEY = 'scr-made'

export const SCREEN_CONSENT_TEXT = {
  asked: (app: string) => `Asked the owner to allow ${app} on this Mac. Try again after they answer.`,
  notNow: (app: string) =>
    `The owner said not now to letting you control ${app} on this Mac. Talos won't ask again for an hour; carry on without it.`,
  cantAsk: (app: string, why: string) =>
    `${app} isn't on this Mac's allowed list yet, and Talos couldn't ask the owner: ${why} Nothing was done.`,
  relayOld: 'the relay needs updating first.',
  busy: 'Talos is already asking the owner about several apps; try again later.',
  noService: 'the main bridge is not running.',
  title: (app: string) => `Let your agent control ${app} on this Mac?`,
  summary:
    'Any session of yours on this Mac could then see its windows and click and type in it. Remove it any time on the Mac: Talos → Settings → Permissions → "Apps your agent may control".',
  warning: 'Your agent could click and type in this app.',
  allowed: (app: string) => `Allowed. Your agent can now use ${app} on this Mac.`,
  notSigned: "This approval wasn't signed by your device, so nothing was allowed.",
  macOff:
    "Talos.app isn't running on this Mac, so nothing was allowed. Open it, then let your agent try again; Talos asks you again.",
  macRefused: (why: string) => `Nothing was allowed: ${why}`,
  restarted:
    'The bridge restarted before this reached the Mac, so it may not have been allowed. Check on the Mac: Talos → Settings → Permissions → "Apps your agent may control".',
} as const

/** The app the Mac measured, as `ask_info` answers it and as the card's payload carries it. */
export type ScreenAllowApp = {
  bundle_id: string
  team_id: string | null
  requirement: string
  name: string
  signer: 'apple' | 'developer' | 'adhoc'
}

/** Control characters and the marks that turn text direction around: never shown as they are. */
const unsafeChar = (c: number) =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x200e ||
  c === 0x200f ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069)

/** An app's own name for display: one line, no control or direction-changing characters, at most 80 characters. */
export function displayName(s: string | undefined): string {
  const one = [...(s ?? '')]
    .map((ch) => (unsafeChar(ch.codePointAt(0) ?? 0) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...one]
  return chars.length === 0 ? 'That app' : chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : one
}

/** The Mac's `ask_info` answer, strictly; null for anything else. */
export function parseMeasured(body: Record<string, unknown>): ScreenAllowApp | null {
  const { bundle_id: b, team_id: t, requirement: r, name: n, signer: s } = body
  if (typeof b !== 'string' || b.length < 1 || b.length > 255) return null
  if (t !== null && (typeof t !== 'string' || t.length < 1 || t.length > 20)) return null
  if (typeof r !== 'string' || r.length < 1 || r.length > 4096) return null
  if (s !== 'apple' && s !== 'developer' && s !== 'adhoc') return null
  return { bundle_id: b, team_id: t, requirement: r, name: displayName(typeof n === 'string' ? n : b), signer: s }
}

/** A card this file made. */
export function isScreenAllowCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.screen_allow === 'object' && p.screen_allow !== null
}

const signedBy = (a: ScreenAllowApp) =>
  a.signer === 'apple'
    ? 'Apple'
    : a.signer === 'adhoc'
      ? 'no developer (this exact build only; an update asks again)'
      : a.team_id
        ? `developer team ${a.team_id}`
        : 'a developer with no team id'

/** One app is one signed identity: the id and its requirement (an impostor with the same id is another app). */
const keyOf = (a: ScreenAllowApp) =>
  `${KEY}${a.bundle_id}|${createHash('sha256').update(a.requirement).digest('hex').slice(0, 16)}`

type Rec = { card_id?: string; not_now_until?: number; name: string }

export class ScreenConsent {
  private relayFeatures: readonly string[] = []
  /** The Mac's name on the card (which Mac the app is allowed on). Tests give a fixed one. */
  macName: () => string = () => hostname()

  constructor(private readonly ctx: BridgeContext) {}

  setRelayFeatures(features: readonly string[]): void {
    this.relayFeatures = features
  }

  private rec(key: string): Rec | undefined {
    try {
      const raw = this.ctx.store.kvGet(key)
      return raw ? (JSON.parse(raw) as Rec) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * A session hit an app off the list; `ask` is the Mac's id for it. Answers the agent's sentence. Never waits on the owner, and
   * makes at most one card per app per Mac at a time.
   */
  async ask(askId: string, hintRaw = 'That app'): Promise<{ ok: boolean; text: string }> {
    const { ctx } = this
    const hint = displayName(hintRaw)
    const cant = (why: string, app = hint) => ({ ok: false, text: SCREEN_CONSENT_TEXT.cantAsk(app, why) })
    if (ctx.worker || ctx.mode !== 'live') return cant(SCREEN_CONSENT_TEXT.noService)
    if (!this.relayFeatures.includes(CONFIG_PROPOSE_FEATURE)) return cant(SCREEN_CONSENT_TEXT.relayOld)
    const info = await screenTransport.request(ctx, { op: 'ask_info', ask: askId })
    if (!info.ok) return cant(refusalText(info))
    const app = parseMeasured(info.body)
    if (!app) return cant('the Mac sent an answer the bridge cannot read.')
    // From here to the ledger write nothing awaits: two sessions asking at once make one card.
    const key = keyOf(app)
    const now = ctx.clock.now()
    const rec = this.rec(key)
    if (rec?.not_now_until !== undefined && rec.not_now_until > now)
      return { ok: false, text: SCREEN_CONSENT_TEXT.notNow(app.name) }
    if (rec?.card_id && ctx.ledger.get(rec.card_id)?.state === 'pending')
      return { ok: false, text: SCREEN_CONSENT_TEXT.asked(app.name) }
    // the caps: a session that finds app after app off the list asks the owner a few at a time, never a stream of cards
    const pending = ctx.ledger
      .list('pending')
      .filter((r) => r.actor === 'bridge' && isScreenAllowCard(r.binding)).length
    const made = this.madeLastHour(now)
    if (pending >= SCREEN_MAX_PENDING || made.length >= SCREEN_MAX_PER_HOUR)
      return { ok: false, text: SCREEN_CONSENT_TEXT.busy }
    const card = this.card(app, now)
    if (typeof card === 'string') return cant(card, app.name)
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch (e) {
      return cant((e as Error).message, app.name)
    }
    ctx.ledger.create(card, 'bridge')
    ctx.store.kvSet(key, JSON.stringify({ card_id: card.id, name: app.name } satisfies Rec))
    ctx.store.kvSet(HOUR_KEY, JSON.stringify([...made, now]))
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      ctx.store.kvDelete(key)
      return cant(`the card could not be sent (${(e as Error).message}).`, app.name)
    }
    ctx.expiry?.sync()
    ctx.log.info('screen consent card posted', { card: card.id, app: app.bundle_id })
    return { ok: false, text: SCREEN_CONSENT_TEXT.asked(app.name) }
  }

  /** When the cards of the last hour were made (kept in the store, so a restart does not reset the count). */
  private madeLastHour(now: number): number[] {
    try {
      const v = JSON.parse(this.ctx.store.kvGet(HOUR_KEY) ?? '[]') as unknown
      return Array.isArray(v)
        ? v.filter((t): t is number => typeof t === 'number' && now - t < 3600_000 && t <= now)
        : []
    } catch {
      return []
    }
  }

  private card(app: ScreenAllowApp, now: number): CardT | string {
    const candidate = {
      id: newId('c'),
      thread_id: defaultThreadRef(this.ctx).id,
      kind: 'config' as const,
      title: clipUnits(SCREEN_CONSENT_TEXT.title(app.name), 120),
      summary: SCREEN_CONSENT_TEXT.summary,
      destination: [{ label: 'Mac', value: clipUnits(displayName(this.macName()), 80) }],
      body: [`App: ${app.name}`, `App id: ${app.bundle_id}`, `Signed by: ${signedBy(app)}`].join('\n'),
      body_format: 'plain' as const,
      fields: [],
      attachments: [],
      warning: SCREEN_CONSENT_TEXT.warning,
      primary_label: 'Allow',
      kill_label: 'Not now',
      allow_edit: false,
      allow_revise: false,
      risk: 'low' as const,
      origin: 'background' as const,
      payload: { v: 1, screen_allow: app },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SCREEN_CARD_EXPIRY_MS).toISOString(),
    }
    const parsed = Card.safeParse(candidate)
    if (!parsed.success) return `the card could not be drawn (${parsed.error.issues[0]?.path.join('.')}).`
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return `the card could not be drawn (${issues.join(', ')}).`
    card.payload_hash = payloadHash(bindingFrom(card))
    return card
  }

  /**
   * The owner answered (inbound has checked the tap and moved the ledger). Allow: the owner's signed frame and the card's binding
   * go to the Mac, which checks them before it writes. Not now: remembered for an hour. `raw` is the frame exactly as received.
   */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', raw: Record<string, unknown>): Promise<void> {
    const { ctx } = this
    const app = (row.binding.payload as { screen_allow?: ScreenAllowApp } | undefined)?.screen_allow
    const name = displayName(app?.name)
    const key = app ? keyOf(app) : undefined
    if (action !== 'primary') {
      if (key && action === 'kill')
        ctx.store.kvSet(key, JSON.stringify({ not_now_until: ctx.clock.now() + SCREEN_NOT_NOW_MS, name } satisfies Rec))
      return
    }
    if (key) ctx.store.kvDelete(key)
    const proof = buildDialogProof(raw, row.binding)
    if (!proof) return this.end(row, false, SCREEN_CONSENT_TEXT.notSigned)
    let a: ScreenAnswer
    try {
      a = await screenTransport.request(ctx, { op: 'allow', proof })
    } catch (e) {
      a = { ok: false, code: 'bad_answer', text: (e as Error).message }
    }
    if (a.ok) return this.end(row, true, SCREEN_CONSENT_TEXT.allowed(name))
    ctx.log.security('screen allow refused by the Mac', { card: row.id, code: a.code })
    if (a.code === 'not_running') return this.end(row, false, SCREEN_CONSENT_TEXT.macOff)
    return this.end(row, false, SCREEN_CONSENT_TEXT.macRefused(refusalText(a)))
  }

  /** Once per process: an Allow that was in flight when the bridge stopped is ended in words, never sent again. */
  recover(): Promise<void> {
    const rows = this.ctx.ledger
      .list('resolved')
      .filter((r) => r.actor === 'bridge' && isScreenAllowCard(r.binding) && r.resolution?.action === 'primary')
    return Promise.all(rows.map((r) => this.end(r, false, SCREEN_CONSENT_TEXT.restarted))).then(() => {})
  }

  private async end(row: LedgerRow, ok: boolean, text: string): Promise<void> {
    const { ctx } = this
    ctx.ledger.finish(row.id, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: { ok, text: clipUnits(text, 500), at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}

/** The agent's sentence for an app the Mac found off the list: through main's service, or through the hub from a thread session. */
export async function askOwnerText(
  ctx: BridgeContext,
  a: Extract<ScreenAnswer, { ok: false }> & { ask?: string },
): Promise<string> {
  const name = displayName(a.app_name ?? a.app)
  if (!a.ask) return refusalText(a)
  try {
    if (ctx.worker) {
      const hub = ctx.worker.hub
      if (!hub) return SCREEN_CONSENT_TEXT.cantAsk(name, 'this session is not connected to the main bridge.')
      return (await hub.rpc('screen_ask', { ask: a.ask, app: name })).text
    }
    if (!ctx.screenConsent) return SCREEN_CONSENT_TEXT.cantAsk(name, SCREEN_CONSENT_TEXT.noService)
    return (await ctx.screenConsent.ask(a.ask, name)).text
  } catch (e) {
    return SCREEN_CONSENT_TEXT.cantAsk(name, `${(e as Error).message}.`)
  }
}
