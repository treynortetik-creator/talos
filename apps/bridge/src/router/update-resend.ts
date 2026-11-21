// A thread's turn that an Update now cut off is OFFERED again, never sent by itself. Nothing here can tell whether the cut turn
// already did something (an always-allowed send, a Bash `git push`), so a second run could repeat it: the owner decides.
//
// The Mac's updater writes `update-interrupted.json` ({"v":1,"at":"<ISO time>","version":"..","commit":"<40 hex>","threads":["<id>",..]}) in its own
// auto-update folder right before the swap. The bridge accepts it only when it could not have come from anywhere else:
//   - the folder and the file are the bridge user's own, with no group or other access (0700 / 0600), and not links;
//   - it names the commit this bridge runs (the release's git sha: the manifest's x.y.z is never the bridge's own version name), and
//     this bridge started after the file's time (an older bridge leaves it alone);
//   - it is at most `MARKER_MAX_AGE_MS` old, and it is deleted the first time it is accepted (read once).
// Even then it can only cause an offer: a card in the thread, "Talos updated while <name> was working on this. It may have stopped
// partway." with Send again and Dismiss. A tap of Send again (the owner's signed card.resolve, in the app) sends one marked copy of each
// message named on the card, once; the message is the one this bridge recorded when the owner sent it, never text from the file or the card.
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  clipUnits,
  newId,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { redelivered } from '../main-resend.ts'
import type { Notification } from '../notify.ts'
import { assertFrameFits } from '../transport.ts'

/** A list older than this is from an earlier update: it names nothing now. */
export const MARKER_MAX_AGE_MS = 60 * 60 * 1000
/** How long the offer stays on the owner's screen. */
export const OFFER_EXPIRY_MS = 24 * 60 * 60 * 1000
/** At most this many messages of one thread ride on one offer (the newest). */
export const OFFER_MAX_MESSAGES = 5
const KINDS = new Set(['text', 'file'])

export type InterruptedList = { at: number; commit: string; threads: Set<string> }
export type ReadResult = { list: InterruptedList | null; why: string }

/** The same commit, whether one side is a short sha (at least 7 hex characters) or both are whole. */
export const sameCommit = (a: string, b: string | undefined): boolean => {
  if (!b || !/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(b)) return false
  return a.startsWith(b) || b.startsWith(a)
}

function unsafe(path: string, mode: 'file' | 'dir', uid: number | undefined): string | null {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return 'absent'
  }
  if (mode === 'file' ? !st.isFile() : !st.isDirectory()) return 'not_plain'
  if (uid !== undefined && st.uid !== uid) return 'wrong_owner'
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return 'wrong_mode'
  return null
}

/**
 * The marker's content when it is the one the Mac's updater just wrote for this bridge, else null with the reason. A file that can
 * never be right (wrong owner or mode, not a file, torn, too old) is deleted; one that is right for another bridge (an older one still
 * running, or another version) is left where it is.
 */
export function readInterrupted(
  path: string,
  o: { now: number; startedAt: number; commit: string | undefined; uid?: number | undefined },
): ReadResult {
  const drop = (why: string): ReadResult => {
    try {
      unlinkSync(path)
    } catch {}
    return { list: null, why }
  }
  const uid = o.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  const f = unsafe(path, 'file', uid)
  if (f === 'absent') return { list: null, why: 'absent' }
  if (f) return drop(f)
  const d = unsafe(dirname(path), 'dir', uid)
  if (d) return { list: null, why: `folder_${d}` } // never trusted; the file in it is not ours to remove
  let v: unknown
  try {
    v = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return drop('unreadable')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return drop('not_a_marker')
  const m = v as Record<string, unknown>
  if (m.v !== 1 || typeof m.at !== 'string' || typeof m.commit !== 'string' || !Array.isArray(m.threads))
    return drop('not_a_marker')
  const at = Date.parse(m.at)
  if (Number.isNaN(at) || at > o.now + 60_000 || o.now - at > MARKER_MAX_AGE_MS) return drop('stale')
  if (!sameCommit(m.commit, o.commit)) return { list: null, why: 'other_commit' }
  if (o.startedAt < at) return { list: null, why: 'bridge_older' }
  const threads = new Set(m.threads.filter((t): t is string => typeof t === 'string'))
  try {
    unlinkSync(path) // read once
  } catch {}
  return { list: { at, commit: m.commit, threads }, why: 'accepted' }
}

/** When the owner last ended a thread's turn by hand (Stop, Restart, Start fresh): kept per thread, in the bridge's store. */
export const turnEndedKey = (thread: string) => `turn_ended:${thread}`
export function noteTurnEnded(ctx: Pick<BridgeContext, 'store' | 'clock'>, thread: string): void {
  ctx.store.kvSet(turnEndedKey(thread), String(ctx.clock.now()))
}
/** Did the owner end this thread's turn by hand at or after `at`? */
export function turnEndedSince(ctx: Pick<BridgeContext, 'store'>, thread: string, at: number): boolean {
  const n = Number(ctx.store.kvGet(turnEndedKey(thread)))
  return Number.isFinite(n) && n >= at
}

/** An owner text or file this bridge held for a thread: the only kind that is ever offered again. */
export function offerable(n: Notification | undefined): n is Notification {
  return !!n && n.meta.trust === 'owner' && KINDS.has(n.meta.kind ?? '') && !n.meta.redelivered
}

/** What the card shows of one message: its first line, without control characters, at most 80 characters. */
export function shownLine(n: Notification | undefined): string {
  const first = (n?.content ?? '').split('\n').find((l) => l.trim() !== '') ?? ''
  const clean = [...first]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .trim()
  return clipUnits(clean, 80) || '(no text)'
}

/** The card's fields for these messages, in order: what the owner reads is what a tap sends, and the payload hash binds it. */
export const fieldsFor = (held: (id: string) => Notification | undefined, ids: string[]) =>
  ids.map((id, i) => ({
    key: `m${i + 1}`,
    label: `Message ${i + 1}`,
    value: shownLine(held(id)),
    editable: false,
    multiline: false,
  }))

/** The copy that goes out on a tap: its own id, marked, with the update's line. */
export function updateCopy(n: Notification): Notification {
  const c = redelivered(n, 'update')
  return { content: c.content, meta: { ...c.meta, message_id: `${n.meta.message_id}~again` } }
}

export const UPDATE_RESEND_TEXT = {
  title: (name: string) => clipUnits(`Talos updated while ${name} was working`, 120),
  body: (name: string) => `Talos updated while ${name} was working on this. It may have stopped partway.`,
  sent: (n: number) => (n === 1 ? 'Sent it again.' : `Sent ${n} messages again.`),
  dismissed: 'Left as it is.',
  already: 'It was already sent again.',
  notFromHere: 'Open the card in the app to send it again.',
  gone: "Talos no longer holds that message, so it can't be sent again. Send it again yourself.",
  failed: 'Talos could not send it again. Send it again yourself.',
} as const

/** A card of this offer (the `config` kind, told apart by its payload, like the permission-mode card). */
export function isUpdateResendCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.update_resend === 'object' && p.update_resend !== null
}

type Deps = {
  /** The owner's message as this bridge recorded it when it was handed to a thread, by id. */
  held(id: string): Notification | undefined
  /** The same path every owner message takes to a thread (the router's own). */
  route(n: Notification): Promise<void>
}

export class UpdateResendCards {
  constructor(
    private readonly ctx: BridgeContext,
    private readonly deps: Deps,
  ) {}

  /** One offer for one thread's cut turn. False when none could be shown (the caller then says the plain words). */
  async offer(a: { thread: string; name: string; ids: string[] }): Promise<boolean> {
    const { ctx } = this
    const now = ctx.clock.now()
    const ids = a.ids.slice(-OFFER_MAX_MESSAGES)
    const parsed = Card.safeParse({
      id: newId('c'),
      thread_id: a.thread,
      kind: 'config' as const,
      title: UPDATE_RESEND_TEXT.title(a.name),
      summary: 'It may have stopped partway.',
      destination: [{ label: 'Thread', value: clipUnits(a.name, 80) }],
      body: UPDATE_RESEND_TEXT.body(a.name),
      body_format: 'plain' as const,
      fields: fieldsFor(this.deps.held, ids),
      attachments: [],
      warning: 'Sending it again repeats the whole request, including anything the agent had already done.',
      primary_label: 'Send again',
      kill_label: 'Dismiss',
      allow_edit: false,
      allow_revise: false,
      risk: 'low' as const,
      origin: 'background' as const,
      payload: { v: 1, update_resend: { thread: a.thread, ids } },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + OFFER_EXPIRY_MS).toISOString(),
    })
    if (!parsed.success) return false
    const card: CardT = parsed.data
    if (validateCard(card).length) return false
    card.payload_hash = payloadHash(bindingFrom(card))
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch {
      return false
    }
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      ctx.log.warn('update resend offer not sent', { error: (e as Error).message })
      return false
    }
    ctx.expiry?.sync()
    return true
  }

  /** The owner answered (inbound has checked the tap and moved the ledger). Only the in-app Send again sends anything. */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', via: string): Promise<void> {
    if (action !== 'primary') return this.end(row, true, UPDATE_RESEND_TEXT.dismissed)
    if (via !== 'card.resolve') return this.end(row, false, UPDATE_RESEND_TEXT.notFromHere)
    const p = (row.binding.payload as { update_resend?: { thread?: unknown; ids?: unknown } } | undefined)
      ?.update_resend
    const ids = Array.isArray(p?.ids) ? p.ids.filter((i): i is string => typeof i === 'string') : []
    if (!ids.length || ids.length > OFFER_MAX_MESSAGES) return this.end(row, false, UPDATE_RESEND_TEXT.failed)
    const { ctx } = this
    // what the owner was shown must still be what would go: the card's own lines against the held messages now
    const shown = row.binding.fields.map((f) => f.value)
    if (ids.length !== shown.length || ids.some((id, i) => shownLine(this.deps.held(id)) !== shown[i]))
      return this.end(row, false, UPDATE_RESEND_TEXT.gone)
    let sent = 0
    let gone = 0
    let failed = 0
    for (const id of ids) {
      const key = `update_resent:${id}`
      if (ctx.store.kvGet(key) !== undefined) continue // once per message, whoever taps and however often
      const n = this.deps.held(id)
      if (!offerable(n) || n.meta.thread_id !== row.thread_id) {
        gone++
        continue
      }
      ctx.store.kvSet(key, String(ctx.clock.now())) // before the send: a second tap or a crash never sends it twice
      try {
        await this.deps.route(updateCopy(n))
        sent++
      } catch (e) {
        failed++
        ctx.log.error('update resend failed', { error: (e as Error).message })
      }
    }
    ctx.log.info('update resend tapped', { card: row.id, sent, gone, failed })
    if (sent > 0) return this.end(row, true, UPDATE_RESEND_TEXT.sent(sent))
    return this.end(
      row,
      false,
      failed ? UPDATE_RESEND_TEXT.failed : gone ? UPDATE_RESEND_TEXT.gone : UPDATE_RESEND_TEXT.already,
    )
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
