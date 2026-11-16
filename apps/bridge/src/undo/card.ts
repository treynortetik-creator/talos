// The undo card: "Undo to here" on an owner message shows a card of kind 'undo', risk high (the passkey), made and acted
// on by the bridge. It says what comes back, that ignored files (like .env) aren't restored, that a git point is the
// whole repository, and lists in an editable box every new file that would be deleted: only what is still in that box
// when the owner approves goes. The card binds the message and the exact point (UndoCardPayload); on approval the bridge
// checks the point is still that one and in the card's thread, then restores (undo-to.ts). A relay or app without
// undo/1 gets no card. Inbound answers it in inbound-cards.ts, before the catch-all bridge-card branch.
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  newId,
  payloadHash,
  UNDO_FEATURE,
  UndoCardPayload,
  type UndoCardPayloadT,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { say } from '../owner-words.ts'
import { assertFrameFits } from '../transport.ts'
import { firstWords } from '../worker/handoff.ts'
import { refreshSchedules, sessionActivity } from './busy.ts'
import { type UndoPointRow, UndoPoints } from './points.ts'
import { planRestore, type RestoreSeams } from './restore.ts'
import { NAMES_DIFFER } from './snapshot.ts'
import { undoTo } from './undo-to.ts'

export const UNDO_CARD_EXPIRY_MS = 60 * 60_000
/** Paths shown per list in the body; the delete box holds every new file that fits in a field. */
const LIST_SHOWN = 40
/** Names shown of the files left in place; the rest are counted. */
const LEFT_SHOWN = 20
/** A shown name longer than this is cut: the lists stay readable and inside the body's limit. */
const NAME_SHOWN = 150
const FIELD_MAX = 19_000

export type ProposeResult = { ok: true; cardId: string } | { ok: false; why: string }

const NOT_READY: Record<string, string> = {
  not_saved: 'No undo point was saved for this message.',
  too_large: 'This folder was too large to save an undo point for.',
}

export class UndoCards {
  private relayFeatures: readonly string[] = []
  /** Cards whose restore runs in this process right now: recovery leaves them alone. */
  private readonly running = new Set<string>()
  /** Test seam: how a restore judges birth times (restore.ts). */
  seams: RestoreSeams = {}

  constructor(private readonly ctx: BridgeContext) {}

  setRelayFeatures(features: readonly string[]): void {
    this.relayFeatures = features
  }

  private points(): UndoPoints {
    return new UndoPoints(this.ctx.store.db)
  }

  /** Shows the undo card for one owner message's point. */
  async propose(messageId: string): Promise<ProposeResult> {
    const { ctx } = this
    if (!this.relayFeatures.includes(UNDO_FEATURE))
      return { ok: false, why: 'The relay and the app need updating before they can show an undo card.' }
    const row = this.points().get(messageId)
    if (!row) return { ok: false, why: 'This message has no undo point.' }
    if (row.state !== 'ready')
      return {
        ok: false,
        why:
          row.why === NAMES_DIFFER
            ? "No undo point was saved for this message: its copy could not keep the folder's file names apart (for example names that differ only in case, like A.txt and a.txt), so it could not be trusted."
            : (NOT_READY[row.state] ?? 'This message has no undo point.'),
      }
    await refreshSchedules(ctx)
    const activity = sessionActivity(ctx, row.root, row.thread_id)
    if (activity.state === 'busy') return { ok: false, why: activity.why }
    const plan = await planRestore(this.points().withLaterIgnored(row), { ...this.seams, undoDir: ctx.paths.undo })
    if (!plan.ok) return { ok: false, why: plan.why }
    if (!plan.rewrite.length && !plan.recreate.length && !plan.extra.length && !plan.blocked.length)
      return { ok: false, why: 'Nothing to undo: the files already match.' }
    const now = ctx.clock.now()
    const words = firstWords(ctx.store.getMessage(messageId)?.text ?? '', 8) || 'this message'
    // a name with a line break in it cannot be one line of the box: it is kept, never offered
    const deletable = fitLines(
      plan.extra.filter((p) => !/[\r\n]/.test(p)),
      FIELD_MAX,
    )
    const list = (title: string, paths: string[], shown = LIST_SHOWN) =>
      paths.length
        ? `${title} (${paths.length}):\n${paths
            .slice(0, shown)
            .map((p) => `  ${p.length > NAME_SHOWN ? `${p.slice(0, NAME_SHOWN)}…` : p}`)
            .join('\n')}${paths.length > shown ? `\n  and ${paths.length - shown} more` : ''}`
        : ''
    const body = [
      "Puts the files back the way they were before this message's turn. The chat is not rewound.",
      activity.state === 'unknown'
        ? "Talos can't tell whether this session is working right now. If it is, stop it before you approve."
        : '',
      plan.kind === 'git'
        ? `This undoes the whole repository at ${plan.root}, not only this session's folder: every edit made there since then goes back, whoever made it.`
        : `This undoes the folder ${plan.root}.`,
      // every explanation comes before the lists, so a long list can never push one past the body's limit
      noDeletesLine(plan.noDeletes),
      plan.extra.length
        ? `New since then (${plan.extra.length}): the ones left in the Delete box are deleted; take a line out to keep that file.${
            deletable.length < plan.extra.length
              ? ` ${plan.extra.length - deletable.length} more did not fit in the box and are kept.`
              : ''
          }`
        : '',
      list('Comes back as it was', plan.rewrite),
      list('Comes back (deleted since)', plan.recreate),
      list("Can't come back: something new is in the way", plan.blocked),
      // read-only: a file not proved new never gets a Delete box; the owner deletes it by hand if it should go
      plan.noDeletes
        ? list('Left in place: new since this turn', plan.leftInPlace, LEFT_SHOWN)
        : list('Left in place (they were there before)', plan.leftInPlace, LEFT_SHOWN),
    ]
      .filter(Boolean)
      .join('\n\n')
    const payload: UndoCardPayloadT = {
      v: 1,
      message_id: messageId as UndoCardPayloadT['message_id'],
      kind: row.kind,
      root: row.root,
      ...(row.commit_id ? { commit_id: row.commit_id } : {}),
      ...(row.path ? { path: row.path } : {}),
      created_at: row.created_at,
    }
    const parsed = Card.safeParse({
      id: newId('c'),
      thread_id: row.thread_id,
      kind: 'undo',
      title: `Undo files to "${words}"`.slice(0, 120),
      summary: `${plan.rewrite.length + plan.recreate.length} files come back, ${deletable.length} new files deleted`,
      destination: [{ label: 'Folder', value: plan.root.slice(0, 500) }],
      body: body.slice(0, 20_000),
      body_format: 'plain',
      fields: deletable.length
        ? [
            {
              key: 'delete',
              label: 'Delete these new files',
              value: deletable.join('\n'),
              editable: true,
              multiline: true,
            },
          ]
        : [],
      attachments: [],
      warning: say({
        mac: "Rewrites files on your Mac; ignored files (like .env) aren't restored.",
        linux: "Rewrites files on your computer; ignored files (like .env) aren't restored.",
      }),
      primary_label: 'Undo files',
      kill_label: 'Keep files',
      allow_edit: deletable.length > 0,
      allow_revise: false,
      risk: 'high',
      origin: 'chat',
      payload,
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + UNDO_CARD_EXPIRY_MS).toISOString(),
    })
    if (!parsed.success) return { ok: false, why: `The card could not be drawn: ${parsed.error.issues[0]?.message}` }
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return { ok: false, why: `The card could not be drawn: ${issues.join(', ')}` }
    card.payload_hash = payloadHash(bindingFrom(card))
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch (e) {
      return { ok: false, why: (e as Error).message }
    }
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      return { ok: false, why: `The card could not be sent to the app: ${(e as Error).message}` }
    }
    ctx.expiry?.sync()
    return { ok: true, cardId: card.id }
  }

  /** The owner's answer. Only Undo files does anything; it restores what the APPROVED binding names, nothing else. */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', approved: CardBinding, cardId: string) {
    if (action !== 'primary') return
    const payload = UndoCardPayload.safeParse(approved.payload)
    if (!payload.success) return this.end(cardId, false, 'The card could not be read. Nothing was changed.')
    const point = this.points().get(payload.data.message_id)
    const why = mismatch(point, payload.data, row.thread_id)
    if (why) {
      this.ctx.log.security('undo card refused at apply', { card: cardId, why })
      return this.end(cardId, false, `${why} Nothing was changed.`)
    }
    const box = approved.fields.find((f) => f.key === 'delete')?.value ?? ''
    // exact names only: a line is not trimmed, so " x" never deletes x (restore deletes only exact new-file names)
    const deletes = box
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean)
    this.running.add(cardId)
    await refreshSchedules(this.ctx) // a background job that started since the card was shown
    let done: Awaited<ReturnType<typeof undoTo>>
    try {
      done = await undoTo(this.ctx, {
        messageId: payload.data.message_id,
        deletes,
        seams: this.seams,
        // again with the restore's turn: the session may have started working since the card was shown
        check: (now) => {
          const activity = sessionActivity(this.ctx, now?.root ?? payload.data.root, row.thread_id)
          return activity.state === 'busy' ? activity.why : mismatch(now, payload.data, row.thread_id)
        },
      })
    } finally {
      this.running.delete(cardId)
    }
    // "nothing was changed" only when no file was written: a restore that stopped partway says so itself
    if (!done.ok) {
      if (!done.partial) return this.end(cardId, false, `${done.why} Nothing was changed.`)
      // the list fits in what the 500-character result leaves after the reason, whole names only
      const may = done.mayHaveChanged ?? []
      const room = 480 - done.why.length - ' These may have changed: '.length
      const shown: string[] = []
      for (const p of may) {
        if (shown.join(', ').length + p.length + 2 > room - 20) break
        shown.push(p)
      }
      const more = may.length > shown.length ? ` and ${may.length - shown.length} more` : ''
      const listed = !may.length
        ? ''
        : shown.length
          ? ` These may have changed: ${shown.join(', ')}${more}.`
          : ` ${may.length} files may have changed.`
      return this.end(cardId, false, `${done.why}${listed}`)
    }
    const moved = done.rewritten.length + done.recreated.length
    const left = done.blocked.length + done.failed.length
    return this.end(
      cardId,
      true,
      `${moved} ${moved === 1 ? 'file' : 'files'} back, ${done.deleted.length} deleted${left ? `, ${left} left as they are` : ''}.`,
    )
  }

  /**
   * A restart between the owner's approval and `end()` leaves an undo card on `resolved` with nobody to finish it. Once
   * per process: say what may be true, never "working on it" for good.
   */
  async recover() {
    for (const row of this.ctx.ledger.list('resolved')) {
      if (row.actor !== 'bridge' || row.binding.kind !== 'undo' || row.resolution?.action !== 'primary') continue
      if (this.running.has(row.id)) continue
      await this.end(row.id, false, 'The bridge restarted during the undo. Some files may be back: check the folder.')
    }
  }

  private async end(cardId: string, ok: boolean, text: string) {
    const { ctx } = this
    if (!ctx.ledger.finish(cardId, ok)) return // ended by someone else meanwhile: say nothing more
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: cardId,
          state: ok ? 'done' : 'failed',
          result: { ok, text: text.slice(0, 500), at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}

/** Why the bound point is not the one to restore now, or undefined when it is. */
function mismatch(point: UndoPointRow | undefined, p: UndoCardPayloadT, cardThread: string): string | undefined {
  if (point?.state !== 'ready') return 'That undo point is gone.'
  if (point.thread_id !== cardThread) return "That undo point is not this thread's."
  const same =
    point.kind === p.kind &&
    point.root === p.root &&
    (point.commit_id ?? undefined) === p.commit_id &&
    (point.path ?? undefined) === p.path &&
    point.created_at === p.created_at
  return same ? undefined : 'That undo point has changed since the card was made.'
}

/** Why the Delete box is empty, in the owner's words: nothing is offered for deletion unless it is provably new. */
function noDeletesLine(n: { why: string; example?: string; fs?: string } | undefined): string {
  if (!n) return ''
  if (n.why === 'ignored_gone')
    return `Some ignored files from before this message are gone or changed (for example ${n.example}), so nothing will be deleted. Check the new files by hand.`
  if (n.why === 'incomplete')
    return 'This folder had too many ignored files for Talos to track, so nothing will be deleted; new files are listed as left in place.'
  if (n.why === 'fs_unproven' && n.fs === 'unknown')
    return "Talos can't tell which file system this folder is on, so none of the new files will be deleted; they're listed as left in place."
  if (n.why === 'fs_unproven')
    return `This folder is on a file system (${n.fs}) Talos can't prove new files on, so none will be deleted; they're listed as left in place.`
  if (n.why === 'unprovable')
    return "Talos can't prove which files here are new, so none will be deleted; they're listed as left in place."
  return 'Talos has no full record of what was here before this message, so nothing will be deleted; new files are listed as left in place.'
}

/** As many lines as fit in `max` characters, joined by newlines. */
function fitLines(lines: string[], max: number): string[] {
  const out: string[] = []
  let size = 0
  for (const l of lines) {
    if (size + l.length + 1 > max) break
    out.push(l)
    size += l.length + 1
  }
  return out
}
