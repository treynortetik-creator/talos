// `permission_mode` (tools/permission-mode.ts): the agent, asked by the owner, changes how Main asks permission. This file is the
// rest of it: the request file the Mac app acts on, and the consent card the owner answers when the change is looser than he
// has said yes to.
//
// The request file, `$TALOS_APP_HOME/permission-mode-request.json` (mode 0600, atomic), is read by the Mac app
// (PermissionModeRequest.swift): {"v":1,"action":"set_permission_mode","mode":"auto|ask|bypass","control_id","ts":<unix ms>}. Any
// program running as the owner can write it, and it does not say who asked, so the Mac's checks are what stand behind it: it acts on a
// well-formed, fresh request only while "Lock Talos settings" is off (it reads config.json again), tells the phone "The agent asked to
// switch ..." (never "as you asked"), and Main does not run in the new mode until the owner confirms the development-channel dialog at the
// Mac or on the phone card, because the changed launch is a cold start. The agent's own Write, Edit and shell commands that name the file
// are denied it (guards/rules.ts).
//
// The consent card is the bridge's own settings card (kind `config`, a payload of its own, like screen-consent.ts) and is never applied
// from a notification: only the owner's signed `card.resolve` in the app reaches `onResolved` (inbound-cards.ts refuses a notification
// tap on it, and `onResolved` checks the frame kind again). There is no Mac proof to send: on Allow the bridge writes the request file,
// the same write a direct change makes.
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_REQUEST_MIN_GAP_MS,
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  clipUnits,
  newId,
  newUlid,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from './cards-ledger.ts'
import type { BridgeContext } from './context.ts'
import { cardCreateFrame, cardUpdateFrame } from './frames-out.ts'
import { writeJsonAtomic } from './fsutil.ts'
import { machineName } from './owner-words.ts'
import { assertFrameFits } from './transport.ts'
import { SETTINGS_LOCKED } from './trust.ts'

export const PERMISSION_MODE_REQUEST_FILE = 'permission-mode-request.json'
export const PERMISSION_MODES = ['auto', 'ask', 'bypass'] as const
export type PermissionModeName = (typeof PERMISSION_MODES)[number]

/** The names the owner sees, the same as the Mac settings picker. */
export const PERMISSION_MODE_LABEL: Record<PermissionModeName, string> = {
  auto: 'Auto (recommended)',
  ask: 'Ask me',
  bypass: 'Bypass all',
}

/** "Not now" holds this long for that mode. */
export const PERMISSION_NOT_NOW_MS = 3600_000
/** An unanswered card lives a day. */
export const PERMISSION_CARD_EXPIRY_MS = 24 * 3600_000
/** At most this many consent cards in an hour. */
export const PERMISSION_MAX_PER_HOUR = 6
const NOT_NOW_KEY = (mode: PermissionModeName) => `pmc:${mode}`
const HOUR_KEY = 'pmc-made'
const LAST_KEY = 'pmr:last'

export const isPermissionMode = (v: unknown): v is PermissionModeName =>
  typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)

export const PERMISSION_MODE_TEXT = {
  notMac:
    'Changing the permission mode is a setting of the Talos app on the Mac. This computer has none, so nothing was changed.',
  asked: (mode: PermissionModeName) =>
    `Asked the owner to allow switching to ${PERMISSION_MODE_LABEL[mode]}. Nothing was changed. Try again after they answer.`,
  notNow: (mode: PermissionModeName) =>
    `The owner said not now to switching to ${PERMISSION_MODE_LABEL[mode]}. Talos won't ask again for an hour; carry on in the current mode.`,
  cantAsk: (why: string) => `Nothing was changed: Talos could not ask the owner (${why}).`,
  relayOld: 'the relay needs updating first',
  busy: 'Talos is already asking the owner about several changes; try again later',
  noService: 'the main bridge is not running',
  pending:
    'Nothing was changed: an earlier permission-mode request is still waiting for the Mac app to take it. Try again in a minute.',
  tooSoon: (wait: string) =>
    `Nothing was changed: the permission mode was asked to change less than 2 minutes ago, and the Mac ignores a request this soon. Try again in ${wait}.`,
  notWritten: 'Nothing was changed: the request for the Mac could not be written.',
  restarted:
    'The bridge restarted before this reached the Mac, so the mode may not have changed. Ask your agent again.',
  allowed: (mode: PermissionModeName) =>
    `Allowed. Sent to the Mac, which saves ${PERMISSION_MODE_LABEL[mode]} and restarts Main when it has finished what it is doing; the Mac posts whether it saved. If it did, the new start waits for you to confirm the startup dialog at the Mac.`,
  notFromHere: 'This can only be allowed from the card in the app. Nothing was changed.',
  lockedAtApproval: `${SETTINGS_LOCKED} Nothing was changed.`,
  title: (mode: PermissionModeName) => `Allow the agent to switch to ${PERMISSION_MODE_LABEL[mode]}?`,
  summary: (mode: PermissionModeName) =>
    mode === 'bypass'
      ? 'Nothing would ask first any more, and no permission cards would reach your phone. Talos restarts the agent when it has finished what it is doing. You can change it back in Mac settings → Session → Permission mode.'
      : 'The agent would run without routine prompts and ask for the rest. Talos restarts the agent when it has finished what it is doing. You can change it back in Mac settings → Session → Permission mode.',
  warning: (mode: PermissionModeName) =>
    mode === 'bypass'
      ? 'The agent could then do anything without asking you.'
      : 'Main restarts when it has finished what it is doing.',
  /** What the agent is told after a direct change. */
  done: (mode: PermissionModeName) =>
    `Asked the Talos app on the Mac to switch Main to ${PERMISSION_MODE_LABEL[mode]}. Sent to the Mac, which saves it and restarts Main when it has finished; the Mac posts whether it saved. If it saves, Main will restart when it has finished what it is doing and this session will end then. The new start waits at the development-channel dialog until the owner confirms it at the Mac (or on the phone card), so Main is quiet until then. The Mac app tells the owner itself.`,
} as const

function waitWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000))
  return s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`
}

/**
 * The one write: refused when an earlier request is still there (the Mac has not taken it) or when one was written less than two
 * minutes ago (the Mac refuses a sooner one too). The time is kept in the store, so a restart does not forget it.
 */
export function writePermissionModeRequest(
  ctx: BridgeContext,
  mode: PermissionModeName,
): { ok: true } | { ok: false; text: string } {
  const path = join(ctx.paths.home, PERMISSION_MODE_REQUEST_FILE)
  try {
    lstatSync(path)
    return { ok: false, text: PERMISSION_MODE_TEXT.pending }
  } catch {
    // nothing there: the way is clear
  }
  const now = ctx.clock.now()
  const last = Number(ctx.store.kvGet(LAST_KEY))
  if (Number.isFinite(last) && last <= now && now - last < AGENT_REQUEST_MIN_GAP_MS)
    return { ok: false, text: PERMISSION_MODE_TEXT.tooSoon(waitWords(AGENT_REQUEST_MIN_GAP_MS - (now - last))) }
  try {
    writeJsonAtomic(path, { v: 1, action: 'set_permission_mode', mode, control_id: newUlid(), ts: now })
  } catch {
    return { ok: false, text: PERMISSION_MODE_TEXT.notWritten }
  }
  ctx.store.kvSet(LAST_KEY, String(now))
  return { ok: true }
}

/** A card this file made. */
export function isPermissionModeCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.permission_mode === 'object' && p.permission_mode !== null
}

const modeOfCard = (row: Pick<LedgerRow, 'binding'>): PermissionModeName | undefined => {
  const m = (row.binding.payload as { permission_mode?: { mode?: unknown } } | undefined)?.permission_mode?.mode
  return isPermissionMode(m) ? m : undefined
}

type Rec = { card_id?: string; not_now_until?: number }

export class PermissionModeConsent {
  private relayFeatures: readonly string[] = []

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

  /**
   * The agent asked for a change the owner has not said yes to. Answers the agent's sentence at once and never waits on the owner.
   * At most one card per mode at a time. Nothing between the ledger check and its write awaits: two calls at once make one card.
   */
  async ask(mode: PermissionModeName, threadId: string): Promise<{ ok: boolean; text: string }> {
    const { ctx } = this
    const cant = (why: string) => ({ ok: false, text: PERMISSION_MODE_TEXT.cantAsk(why) })
    if (ctx.worker || ctx.mode !== 'live') return cant(PERMISSION_MODE_TEXT.noService)
    if (!this.relayFeatures.includes(CONFIG_PROPOSE_FEATURE)) return cant(PERMISSION_MODE_TEXT.relayOld)
    const key = NOT_NOW_KEY(mode)
    const now = ctx.clock.now()
    const rec = this.rec(key)
    if (rec?.not_now_until !== undefined && rec.not_now_until > now)
      return { ok: false, text: PERMISSION_MODE_TEXT.notNow(mode) }
    if (rec?.card_id && ctx.ledger.get(rec.card_id)?.state === 'pending')
      return { ok: false, text: PERMISSION_MODE_TEXT.asked(mode) }
    const made = this.madeLastHour(now)
    if (made.length >= PERMISSION_MAX_PER_HOUR) return cant(PERMISSION_MODE_TEXT.busy)
    const card = this.card(mode, threadId, now)
    if (typeof card === 'string') return cant(card)
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch (e) {
      return cant((e as Error).message)
    }
    ctx.ledger.create(card, 'bridge')
    ctx.store.kvSet(key, JSON.stringify({ card_id: card.id } satisfies Rec))
    ctx.store.kvSet(HOUR_KEY, JSON.stringify([...made, now]))
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      ctx.store.kvDelete(key)
      return cant(`the card could not be sent: ${(e as Error).message}`)
    }
    ctx.expiry?.sync()
    ctx.log.info('permission mode card posted', { card: card.id, mode })
    return { ok: false, text: PERMISSION_MODE_TEXT.asked(mode) }
  }

  private card(mode: PermissionModeName, threadId: string, now: number): CardT | string {
    const candidate = {
      id: newId('c'),
      thread_id: threadId,
      kind: 'config' as const,
      title: clipUnits(PERMISSION_MODE_TEXT.title(mode), 120),
      summary: PERMISSION_MODE_TEXT.summary(mode),
      destination: [{ label: 'Mac', value: clipUnits(machineName(), 80) }],
      body: `New permission mode: ${PERMISSION_MODE_LABEL[mode]}`,
      body_format: 'plain' as const,
      fields: [],
      attachments: [],
      warning: PERMISSION_MODE_TEXT.warning(mode),
      primary_label: 'Allow',
      kill_label: 'Not now',
      allow_edit: false,
      allow_revise: false,
      risk: 'low' as const,
      origin: 'background' as const,
      payload: { v: 1, permission_mode: { mode } },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PERMISSION_CARD_EXPIRY_MS).toISOString(),
    }
    const parsed = Card.safeParse(candidate)
    if (!parsed.success) return `the card could not be drawn (${parsed.error.issues[0]?.path.join('.')})`
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return `the card could not be drawn (${issues.join(', ')})`
    card.payload_hash = payloadHash(bindingFrom(card))
    return card
  }

  /**
   * The owner answered (inbound has checked the tap and moved the ledger). Allow: the lock is looked at again NOW, then the request
   * is written. Not now: remembered for an hour.
   */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', via: string): Promise<void> {
    const { ctx } = this
    const mode = modeOfCard(row)
    if (!mode) return this.end(row, false, PERMISSION_MODE_TEXT.notWritten)
    // only the owner's signed card.resolve applies it; a notification tap (native.act) never does (inbound-cards.ts refuses that earlier)
    if (action === 'primary' && via !== 'card.resolve') return this.end(row, false, PERMISSION_MODE_TEXT.notFromHere)
    if (action !== 'primary') {
      if (action === 'kill')
        ctx.store.kvSet(
          NOT_NOW_KEY(mode),
          JSON.stringify({ not_now_until: ctx.clock.now() + PERMISSION_NOT_NOW_MS } satisfies Rec),
        )
      return
    }
    ctx.store.kvDelete(NOT_NOW_KEY(mode))
    ctx.config.refresh()
    if (ctx.config.config.settings_lock === true) return this.end(row, false, PERMISSION_MODE_TEXT.lockedAtApproval)
    const w = writePermissionModeRequest(ctx, mode)
    if (!w.ok) return this.end(row, false, w.text)
    ctx.log.security('permission mode change approved by the owner', { card: row.id, mode })
    return this.end(row, true, PERMISSION_MODE_TEXT.allowed(mode))
  }

  /** Once per process: an Allow that was in flight when the bridge stopped is ended in words, never written again. */
  recover(): Promise<void> {
    const rows = this.ctx.ledger
      .list('resolved')
      .filter((r) => r.actor === 'bridge' && isPermissionModeCard(r.binding) && r.resolution?.action === 'primary')
    return Promise.all(rows.map((r) => this.end(r, false, PERMISSION_MODE_TEXT.restarted))).then(() => {})
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
