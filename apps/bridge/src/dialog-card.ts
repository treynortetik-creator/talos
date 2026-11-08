// Needs-you prompts (docs/OPTION-C.md "Needs-you prompts"). The desktop supervisor records a known Claude Code dialog of a
// thread session in workers.json; this makes a `kind:'dialog'` card from it, takes the owner's tap (first answer wins, in the
// ledger), writes the answer file the Mac presses from, and closes the card from the Mac's report. The agent is never told:
// this is the bridge's own card, answered by a key press, not by a message.
//
// Nothing in the files here is trusted to say who answered: anything running as the same user can write them. The answer file
// carries the owner's own signature on the tap (`proof`), which the Mac checks before it presses; every other file only changes
// what a card SAYS. They are read like untrusted text: a regular file, no link followed (the folders too), a size cap, strict
// fields, and a time check.
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDialogProof,
  composeDialogCard,
  DIALOG_ALREADY_ANSWERED_TEXT,
  DIALOG_ANSWER_MAX_BYTES,
  DIALOG_CLOSED_TEXT,
  DIALOG_FILE_MAX_BYTES,
  DIALOG_MISMATCH_TEXT,
  DIALOG_OPEN_LABEL,
  DIALOG_OPENED_TEXT,
  DIALOG_RESULT_WAIT_MS,
  DIALOG_UNCONFIRMED_TEXT,
  DIALOG_UNVERIFIED_TEXT,
  DialogAnswer,
  type DialogAnswerT,
  DialogCardFile,
  type DialogCardFileT,
  type DialogKindT,
  DialogResult,
  type DialogResultT,
  dialogAnswerText,
  dialogFallbackLine,
  dialogFileFresh,
  dialogNothingPressedText,
  dialogOf,
  type ErrorCodeT,
  type Frame,
  NEEDS_YOU_FEATURE,
  newId,
  parseDialogFile,
  supervisorFresh,
  verifyDialogAnswer,
  WORKER_FILES,
  type WorkersFileT,
} from '@talos-app/protocol'
import type { LedgerRow } from './cards-ledger.ts'
import { type BridgeContext, postSystemNotice, threadRef } from './context.ts'
import { cardCreateFrame, cardUpdateFrame } from './frames-out.ts'
import { removeFile, writeFileAtomic } from './fsutil.ts'
import { readRegularFile } from './safe-open.ts'
import { assertFrameFits } from './transport.ts'
import { WorkersReader } from './worker/files.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

/** How often files the Mac writes are looked at while a dialog card is open. workers.json changes poke the bridge sooner. */
const WATCH_MS = 1000
/** Records of finished dialogs are kept this long, so a dialog id seen again is never carded twice. */
const KEEP_MS = 2 * 24 * 3600_000
const NOT_HANDED_OVER = "Couldn't hand your answer to the Mac. Nothing was pressed."
const KEY = 'dlg:'

type Phase = 'waiting' | 'answering' | 'done' | 'closed' | 'expired'
type Rec = {
  card_id: string
  thread: string
  kind: DialogKindT
  phase: Phase
  /** When the record last changed (ms). */
  at: number
  control_id?: string
  /** What the answer chose: the option index (null: the login card's one button) and its label as the owner saw it. */
  choice?: number | null
  label?: string
  /** When the answer was recorded (ms). The Mac has DIALOG_RESULT_WAIT_MS from here. */
  answered_at?: number
  /** The owner pressed an option on the Mac popup (the Mac says so in a result); display only, applied once the dialog is gone. */
  mac?: { choice: number | null; label: string | null }
  /** The thread line for an expired dialog was posted (or tried: at most once). */
  line?: true
}

export type DialogPrecheck =
  | { handled: false }
  | { handled: true; ok: false; code: ErrorCodeT; reason: string }
  | { handled: true; ok: true; choice: number | null; by: string }

export class DialogCards {
  private relayOk = false
  private stopped = false
  private timer: unknown
  private readonly reader: WorkersReader

  constructor(private readonly ctx: BridgeContext) {
    this.reader = new WorkersReader(ctx.paths.home)
  }

  /** Called with every `ready`: a relay that does not list needs-you/1 would refuse the card kind, so none is made. */
  setRelayFeatures(features: readonly string[]): void {
    this.relayOk = features.includes(NEEDS_YOU_FEATURE)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.ctx.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  // ---- records -------------------------------------------------------------------------------------------------

  private rec(dialogId: string): Rec | undefined {
    const raw = this.ctx.store.kvGet(KEY + dialogId)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as Rec
    } catch {
      return undefined
    }
  }
  private save(dialogId: string, rec: Rec): void {
    rec.at = this.ctx.clock.now()
    this.ctx.store.kvSet(KEY + dialogId, JSON.stringify(rec))
  }
  private all(): Array<[string, Rec]> {
    const out: Array<[string, Rec]> = []
    for (const key of this.ctx.store.kvKeys(KEY)) {
      const rec = this.rec(key.slice(KEY.length))
      if (rec) out.push([key.slice(KEY.length), rec])
    }
    return out
  }
  private byCard(cardId: string): [string, Rec] | undefined {
    return this.all().find(([, r]) => r.card_id === cardId)
  }

  // ---- files ---------------------------------------------------------------------------------------------------

  private path(thread: string, name: string): string {
    return join(this.ctx.paths.home, 'workers', thread, name)
  }
  /**
   * The folder `workers/<thread>` with no link in it. `workers` and the thread folder are looked at with lstat: a link there
   * (made by anything running as this user) would send a read or a write somewhere else, so it is refused. `create` makes the
   * folders that are missing (0700); an existing folder is never chmod-ed.
   */
  private folder(thread: string, create: boolean): boolean {
    const home = this.ctx.paths.home
    for (const dir of [join(home, 'workers'), join(home, 'workers', thread)]) {
      let st: ReturnType<typeof lstatSync> | undefined
      try {
        st = lstatSync(dir)
      } catch {
        st = undefined
      }
      if (!st) {
        if (!create) return false
        mkdirSync(dir, { mode: 0o700 })
      } else if (st.isSymbolicLink() || !st.isDirectory()) return false
    }
    return true
  }
  private readFile<T>(
    thread: string,
    name: string,
    schema: Parameters<typeof parseDialogFile>[0],
    max: number,
  ): T | null {
    if (!this.folder(thread, false)) return null
    const path = this.path(thread, name)
    try {
      if (!lstatSync(path).isFile()) return null // a link, a pipe or a folder is not a file of ours
    } catch {
      return null
    }
    const buf = readRegularFile(path, max)
    return buf ? (parseDialogFile(schema, buf.toString('utf8')) as T | null) : null
  }
  private writeFile(thread: string, name: string, body: unknown): void {
    if (!this.folder(thread, true)) throw new Error(`workers/${thread} is a link or not a folder`)
    writeFileAtomic(this.path(thread, name), `${JSON.stringify(body)}\n`, 0o600)
  }
  private removeOwn(thread: string, name: string): void {
    if (this.folder(thread, false)) removeFile(this.path(thread, name))
  }
  /** The card file the Mac reads. Best effort: a failed write is logged, the card itself stands. */
  private writeCardFile(thread: string, dialogId: string, cardId: string, patch: Partial<DialogCardFileT> = {}): void {
    try {
      const body: DialogCardFileT = DialogCardFile.parse({
        v: 1,
        dialog_id: dialogId,
        card_id: cardId,
        thread_id: thread,
        status: 'waiting',
        at: new Date(this.ctx.clock.now()).toISOString(),
        ...patch,
      })
      this.writeFile(thread, WORKER_FILES.dialogCard, body)
    } catch (e) {
      this.ctx.log.warn('dialog card file not written', { thread, error: (e as Error).message })
    }
  }
  private readResult(thread: string): DialogResultT | null {
    return this.readFile<DialogResultT>(thread, WORKER_FILES.dialogResult, DialogResult, DIALOG_FILE_MAX_BYTES)
  }

  // ---- the diff ------------------------------------------------------------------------------------------------

  /** Called from the bridge's poll (and by a timer while a dialog card is open). */
  tick(): void {
    const { ctx } = this
    if (ctx.mode !== 'live' || this.stopped) return
    const now = ctx.clock.now()
    const file = this.reader.read()
    const fresh = supervisorFresh(file, now)
    const records = this.all()
    for (const [id, rec] of records) {
      if (rec.phase === 'waiting') this.progressWaiting(id, rec, file, fresh)
      else if (rec.phase === 'answering') this.progressAnswering(id, rec, now)
      else if (now - rec.at > KEEP_MS) ctx.store.kvDelete(KEY + id)
    }
    if (fresh && file && this.relayOk) this.mintNew(file)
    this.watch(records.some(([, r]) => r.phase === 'waiting' || r.phase === 'answering'))
  }

  private watch(wanted: boolean): void {
    if (!wanted || this.stopped || this.timer !== undefined) return
    this.timer = this.ctx.clock.setTimeout(() => {
      this.timer = undefined
      this.tick()
    }, WATCH_MS)
  }

  private progressWaiting(id: string, rec: Rec, file: WorkersFileT | null, fresh: boolean): void {
    // The ledger moved on without this record: the answer was taken and the bridge stopped before it was recorded as handed
    // over, so nothing was written for the Mac and nothing will be. (A card that expired is settled by onCardExpired, which runs
    // in the same turn.)
    const row = this.ctx.ledger.get(rec.card_id)
    if (row && row.state !== 'pending') {
      if (row.state === 'resolved') this.fail(row, NOT_HANDED_OVER)
      this.save(id, { ...rec, phase: row.state === 'resolved' ? 'done' : 'closed' })
      return
    }
    this.takeMacResult(id, rec)
    // only a fresh file can say the dialog is gone: a torn or old one proves nothing
    if (!fresh || !file) return
    if (file.threads[rec.thread]?.dialog?.id === id) return
    const now = this.rec(id)
    if (now?.phase !== 'waiting') return
    if (now.mac) this.finishByMac(id, now)
    else this.close(id, now)
  }

  private mintNew(file: WorkersFileT): void {
    for (const [thread, entry] of Object.entries(file.threads)) {
      const d = entry.dialog
      if (!d || this.rec(d.id) || !this.ctx.config.thread(thread)) continue
      this.mint(thread, d).catch((e) =>
        this.ctx.log.warn('dialog card not made', { thread, error: (e as Error).message }),
      )
    }
  }

  private async mint(thread: string, d: NonNullable<WorkersFileT['threads'][string]['dialog']>): Promise<void> {
    const { ctx } = this
    const now = ctx.clock.now()
    const card = composeDialogCard({
      card_id: newId('c'),
      dialog: d,
      thread_id: thread,
      thread_name: threadRef(ctx, thread).name,
      now,
    })
    if (!card) return
    assertFrameFits(cardCreateFrame(now, card))
    // the record first: a second look at the same file while this one is being sent finds it and makes nothing
    this.save(d.id, { card_id: card.id, thread, kind: d.kind, phase: 'waiting', at: now })
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      this.save(d.id, { card_id: card.id, thread, kind: d.kind, phase: 'closed', at: now })
      throw e
    }
    ctx.expiry?.sync()
    this.writeCardFile(thread, d.id, card.id)
    this.watch(true)
  }

  /** The dialog is gone (answered in Terminal, or the session ended) and nobody answered: the card says so. */
  private close(id: string, rec: Rec): void {
    const { ctx } = this
    const row = ctx.ledger.get(rec.card_id)
    if (row?.state === 'pending' && ctx.ledger.supersede(rec.card_id)) {
      ctx.expiry?.cancel(rec.card_id)
      const at = new Date(ctx.clock.now()).toISOString()
      this.send(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: rec.card_id,
          state: 'superseded',
          result: { ok: true, text: DIALOG_CLOSED_TEXT, at, ran: false },
          reason: 'dialog_gone',
        }),
      )
    }
    this.save(id, { ...rec, phase: 'closed' })
    this.writeCardFile(rec.thread, id, rec.card_id, { status: 'closed' })
  }

  private send(frame: Of<'card.update'>): void {
    this.ctx.transport
      .sendDurable(frame)
      .catch((e) => this.ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  // ---- the owner's tap -----------------------------------------------------------------------------------------

  /**
   * Before the ledger sees a `card.resolve` for a dialog card: a choice that is not one of the card's buttons, a Kill, a Revise,
   * or a dialog that a fresh workers.json shows is no longer the one on the pane is refused WITHOUT touching the ledger. A file
   * that is missing, torn or old proves nothing, so it never refuses a tap (the Mac makes its own check). A card that is no
   * longer pending is left to the ledger, which answers card_not_pending (first answer wins) or card_expired.
   */
  precheck(
    f: { card_id: string; action: 'primary' | 'kill' | 'revise'; choice?: number | undefined; edited?: unknown },
    deviceId: string,
  ): DialogPrecheck {
    const row = this.ctx.ledger.get(f.card_id)
    if (row?.binding.kind !== 'dialog') return { handled: false }
    const by = this.deviceLabel(deviceId)
    if (row.state !== 'pending') return { handled: true, ok: true, choice: f.choice ?? null, by }
    const bad = (reason: string): DialogPrecheck => ({ handled: true, ok: false, code: 'bad_frame', reason })
    const d = dialogOf(row.binding)
    if (!d) return bad('This card cannot be answered.')
    if (f.action !== 'primary' || f.edited !== undefined) return bad('This card is answered with a button.')
    if (d.dialog_kind === 'login' ? f.choice !== undefined : f.choice === undefined || f.choice >= d.options.length)
      return bad('That is not one of the buttons on this card.')
    const found = this.rec(d.dialog_id)
    const file = this.reader.read()
    const gone =
      file !== null && supervisorFresh(file, this.ctx.clock.now()) && file.threads[d.thread]?.dialog?.id !== d.dialog_id
    if (found?.phase !== 'waiting' || gone) {
      if (found?.phase === 'waiting') this.close(d.dialog_id, found)
      return {
        handled: true,
        ok: false,
        code: 'card_not_pending',
        reason: "The session isn't waiting on this any more.",
      }
    }
    return { handled: true, ok: true, choice: f.choice ?? null, by }
  }

  /** The device that tapped, by the name it was paired under. */
  deviceLabel(deviceId: string): string {
    const name = this.ctx.devices.get(deviceId)?.name
    return (name?.trim() || 'a paired device').slice(0, 60)
  }

  /**
   * The ledger accepted the answer (this one won). Hands it to the Mac with the owner's own signed tap as its proof. `raw` is
   * the frame exactly as it arrived (`it.raw`): the signature covers those bytes, not a parsed copy. The record says
   * "answering" BEFORE the file is written, so a stop in between can never be told as "nothing was pressed" while the Mac presses.
   */
  async onResolved(row: LedgerRow, choice: number | null, raw: Record<string, unknown>): Promise<void> {
    const { ctx } = this
    const d = dialogOf(row.binding)
    const found = d ? this.rec(d.dialog_id) : undefined
    if (!d || !found) {
      this.fail(row, NOT_HANDED_OVER)
      return
    }
    const proof = buildDialogProof(raw, row.binding)
    const label = choice === null ? DIALOG_OPEN_LABEL : (d.options[choice] ?? '')
    const nowMs = ctx.clock.now()
    const controlId = newId('c').replace(/^c_/, 'dc_')
    this.save(d.dialog_id, { ...found, phase: 'answering', control_id: controlId, choice, label, answered_at: nowMs })
    const answer: DialogAnswerT | undefined = proof
      ? {
          v: 2,
          dialog_id: d.dialog_id,
          ...(choice === null ? { action: 'open' as const } : { choice }),
          label,
          by: row.resolution?.by ?? this.deviceLabel(proof.device_id),
          at: new Date(nowMs).toISOString(),
          control_id: controlId,
          proof,
        }
      : undefined
    try {
      const checked = DialogAnswer.parse(answer)
      if (Buffer.byteLength(JSON.stringify(checked)) > DIALOG_ANSWER_MAX_BYTES) throw new Error('answer too large')
      // the check the Mac will make, made here first: an answer that would not pass is not handed over
      const file = this.reader.read()
      const live = file?.threads[d.thread]?.dialog
      const verdict = await verifyDialogAnswer(checked, {
        pinnedKey: (id) => ctx.devices.pinnedKey(id),
        nowMs: ctx.clock.now(),
        thread: d.thread,
        pane:
          live?.id === d.dialog_id
            ? { dialog_id: live.id, dialog_kind: live.kind, subject: live.subject, options: live.options }
            : { dialog_id: d.dialog_id, dialog_kind: d.dialog_kind, subject: d.subject, options: d.options },
      })
      if (!verdict.ok) throw new Error(`proof check: ${verdict.why}`)
      this.writeFile(d.thread, WORKER_FILES.dialogAnswer, checked)
    } catch (e) {
      ctx.log.warn('dialog answer not written', { thread: d.thread, error: (e as Error).message })
      this.save(d.dialog_id, { ...(this.rec(d.dialog_id) ?? found), phase: 'done' })
      this.fail(row, NOT_HANDED_OVER)
      return
    }
    this.writeCardFile(d.thread, d.dialog_id, row.id, { status: 'answered', by: answer?.by, label })
    this.watch(true)
  }

  /** The answer could not be handed to the Mac: the card ends failed, with nothing run. */
  private fail(row: LedgerRow, text: string): void {
    const { ctx } = this
    if (!ctx.ledger.finish(row.id, false)) return
    this.send(
      cardUpdateFrame(ctx.clock.now(), {
        card_id: row.id,
        state: 'failed',
        result: { ok: false, text, at: new Date(ctx.clock.now()).toISOString(), ran: false },
      }),
    )
  }

  // ---- what the Mac reports ------------------------------------------------------------------------------------

  /**
   * A result with `source: 'mac'`: the owner pressed an option on the Mac popup. Only what the card says changes, and only
   * once a fresh workers.json shows the dialog gone (`finishByMac`). Label and index must be one of the card's own buttons.
   */
  private takeMacResult(id: string, rec: Rec): void {
    const r = this.readResult(rec.thread)
    if (!r || r.dialog_id !== id || r.source !== 'mac') return
    this.removeOwn(rec.thread, WORKER_FILES.dialogResult)
    const row = this.ctx.ledger.get(rec.card_id)
    const d = row ? dialogOf(row.binding) : null
    if (!d || !dialogFileFresh(r.at, this.ctx.clock.now())) return
    const mac =
      r.outcome === 'opened' && d.dialog_kind === 'login'
        ? { choice: null, label: null }
        : r.outcome === 'pressed' && r.choice !== undefined && d.options[r.choice] === r.label
          ? { choice: r.choice, label: r.label ?? null }
          : undefined
    if (mac) this.save(id, { ...rec, mac })
  }

  /** The owner answered on the Mac popup and the dialog is gone: the card reads "Answered on this Mac" (display only). */
  private finishByMac(id: string, rec: Rec): void {
    const { ctx } = this
    const row = ctx.ledger.get(rec.card_id)
    const d = row ? dialogOf(row.binding) : null
    if (!row || !d || !rec.mac) return
    const out = ctx.ledger.resolve(
      {
        card_id: row.id,
        action: 'primary',
        payload_hash: row.payload_hash,
        ts: new Date(ctx.clock.now()).toISOString(),
      },
      ctx.clock.now(),
      { by: 'this Mac' },
    )
    if (!out.ok || !ctx.ledger.finish(row.id, true)) {
      this.close(id, rec)
      return
    }
    ctx.expiry?.cancel(row.id)
    const at = new Date(ctx.clock.now()).toISOString()
    const text = rec.mac.label === null ? DIALOG_OPENED_TEXT : dialogAnswerText(d.dialog_kind, d.subject, rec.mac.label)
    this.send(
      cardUpdateFrame(ctx.clock.now(), {
        card_id: row.id,
        state: 'done',
        resolution: out.resolution,
        result: { ok: true, text, at, ran: true },
      }),
    )
    this.save(id, { ...rec, phase: 'done' })
    this.writeCardFile(rec.thread, id, row.id, {
      status: 'answered',
      by: 'this Mac',
      ...(rec.mac.label ? { label: rec.mac.label } : {}),
    })
  }

  private progressAnswering(id: string, rec: Rec, now: number): void {
    const r = this.readResult(rec.thread)
    if (r && r.dialog_id === id) {
      if (r.source === 'mac') {
        // a popup press that beat this answer: remembered for the card, taken off the disk
        this.removeOwn(rec.thread, WORKER_FILES.dialogResult)
      } else if (r.control_id === rec.control_id && this.resultIsFresh(r, rec, now)) {
        this.removeOwn(rec.thread, WORKER_FILES.dialogResult)
        this.finish(id, rec, r)
        return
      }
    }
    // The report never came. Say what is known (never that the key was pressed) and take the answer back, so a Mac that is
    // late finds nothing to press.
    if (now - (rec.answered_at ?? rec.at) >= DIALOG_RESULT_WAIT_MS) {
      this.removeOwn(rec.thread, WORKER_FILES.dialogAnswer)
      this.finish(id, rec, null)
    }
  }

  /** A report is only believed if the Mac wrote it after it could have had the answer, and not in the future. */
  private resultIsFresh(r: DialogResultT, rec: Rec, now: number): boolean {
    const at = Date.parse(r.at)
    return Number.isFinite(at) && at >= (rec.answered_at ?? 0) - 60_000 && at <= now + 60_000
  }

  /** The Mac's report on this answer, or null when it never came. */
  private finish(id: string, rec: Rec, result: DialogResultT | null): void {
    const { ctx } = this
    const row = ctx.ledger.get(rec.card_id)
    const d = row ? dialogOf(row.binding) : null
    if (!row || !d) return
    const at = new Date(ctx.clock.now()).toISOString()
    let ok = false
    let ran: boolean | 'unknown' = false
    let text: string
    if (!result) {
      text = DIALOG_UNCONFIRMED_TEXT
      ran = 'unknown'
    } else if (result.outcome === 'nothing_pressed') {
      text =
        result.reason === 'unverified'
          ? DIALOG_UNVERIFIED_TEXT
          : result.reason === 'already_answered'
            ? DIALOG_ALREADY_ANSWERED_TEXT
            : dialogNothingPressedText(threadRef(ctx, rec.thread).name)
    } else if (
      result.outcome === 'opened'
        ? rec.choice !== null
        : rec.choice === null || result.choice !== rec.choice || result.label !== rec.label
    ) {
      // it says it pressed something other than what was answered: nothing is claimed
      text = DIALOG_MISMATCH_TEXT
      ran = 'unknown'
    } else {
      ok = true
      ran = true
      text =
        result.outcome === 'opened' ? DIALOG_OPENED_TEXT : dialogAnswerText(d.dialog_kind, d.subject, rec.label ?? '')
    }
    if (!ctx.ledger.finish(row.id, ok)) return
    this.send(
      cardUpdateFrame(ctx.clock.now(), {
        card_id: row.id,
        state: ok ? 'done' : 'failed',
        ...(row.resolution ? { resolution: row.resolution } : {}),
        result: { ok, text, at, ran },
      }),
    )
    this.save(id, { ...rec, phase: 'done' })
  }

  // ---- expiry --------------------------------------------------------------------------------------------------

  /**
   * A dialog card nobody answered in time (CardExpiry calls this after it sent `expired`). If the dialog is still on the pane
   * the owner gets the thread line the Mac used to post: AT MOST ONE per dialog (the record is marked before the post, and a
   * post that fails is logged, not retried); the worker is never stopped.
   */
  async onCardExpired(row: LedgerRow): Promise<void> {
    const { ctx } = this
    const found = this.byCard(row.id)
    if (!found) return
    const [id, rec] = found
    if (rec.phase !== 'waiting') return
    const still = this.reader.read()?.threads[rec.thread]?.dialog?.id === id
    this.save(id, { ...rec, phase: 'expired', ...(still ? { line: true as const } : {}) })
    this.writeCardFile(rec.thread, id, rec.card_id, { status: 'expired' })
    if (!still) return
    try {
      await postSystemNotice(ctx, dialogFallbackLine(rec.kind, threadRef(ctx, rec.thread).name), {
        thread: threadRef(ctx, rec.thread),
      })
    } catch (e) {
      ctx.log.warn('dialog expiry line not posted', { error: (e as Error).message })
    }
  }
}
