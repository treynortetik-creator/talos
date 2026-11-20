// Needs-you dialogs on a worker's pane, offered as a card and answered by a tap (P3d3, part 4b-ii; the Mac's
// WorkerDialogOffer.swift and WorkerDialogAnswer.swift, with DialogFiles.swift, DialogProofsUsed.swift and DialogAnswer.swift).
//
// The offer: a known dialog (folder trust, MCP consent, the bypass-permissions disclaimer, the development-channels question) that readDialog reads EXACTLY, on a screen that has held still for
// dialog_settle_s, goes into the worker's workers.json entry as `dialog`, so the bridge makes a card. The thread's line waits
// DIALOG_CARD_WAIT_MS for the bridge's dialog-card.json; a dialog the bridge has a card for never gets the line. Login is a line
// only (no card here). Two looks in a row that cannot read the offered dialog end the offer.
//
// The answer: the one narrow exception to "nothing is ever typed into a dialog". dialog-answer.json is taken by rename, then read
// with the hardening of a small file the other side writes (no link, a regular file, capped); each control id is acted on once
// and each signed tap (dialog id | the signed text's hash) once, across restarts too; it must be fresh, for the offered dialog,
// before the card expires, and PROVE ITSELF (verifyDialogAnswer against devices.json and this supervisor's own record of the
// dialog). Then, with no attached client typing in dialog_client_quiet_s (a client list that cannot be read fails closed), ONE
// arrow at a time, each confirmed by a fresh read, and one Enter onto the signed choice's row. dialog-result.json (0600) says
// what happened; a late answer for a dialog already pressed gets `already_answered`.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIALOG_ANSWER_MAX_BYTES,
  DIALOG_CARD_WAIT_MS,
  DIALOG_FILE_MAX_BYTES,
  DialogAnswer,
  type DialogAnswerT,
  DialogCardFile,
  type DialogKeyKind,
  DialogResult,
  dialogFileFresh,
  type JwkP256T,
  keyNotSent,
  type PtyDialogKey,
  type PtySendResult,
  parseDialogFile,
  sha256Hex,
  verifyDialogAnswer,
  WORKER_FILES,
  WORKER_TIMING,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { workerDir } from '../worker/files.ts'
import { type Dialog, readDialog } from './dialog-reader.ts'
import type { Screen } from './screen.ts'

/** What the supervisor keeps about a worker's offered dialog (the offer itself is the entry's `dialog`, in workers.json). */
export type OfferState = {
  /** When (monotonic) this supervisor first saw the offered dialog; null when it has not (none, or read back from disk). */
  sinceAwake: number | null
  /** Looks in a row that could not read the offered dialog; two end the offer. */
  misses: number
  /** The control ids of the answers already taken, so none is acted on twice. */
  controlsSeen: string[]
  /** The dialog id an Enter was sent for: no second Enter for it, whatever arrives. */
  enterSentFor: string | null
  /** The screen changed while an offer stood: what holds still next may be another dialog that looks the same. A new id. */
  disturbed: boolean
  /** Every proof that checked out, so one signed tap is used once (on disk too, dialog-proofs-used.json). */
  proofsUsed: string[]
  /** The owner's tap pressed "No, exit" on the folder-trust question: the session's exit that follows is that answer, not a crash. */
  declinedTrust: boolean
  /** The same for the other two questions whose "no" ends the session: the bypass disclaimer's "No, exit" and the development channel's "Exit". */
  declinedExit: 'bypass' | 'dev_channels' | null
}

export const newOfferState = (): OfferState => ({
  sinceAwake: null,
  misses: 0,
  controlsSeen: [],
  enterSentFor: null,
  disturbed: false,
  proofsUsed: [],
  declinedTrust: false,
  declinedExit: null,
})

/** What the thread is told when the owner answered "No, exit" to the folder-trust question (null: they did not); taking it clears the mark. */
export function declinedTrustText(o: OfferState): string | null {
  const was = o.declinedTrust
  const exit = o.declinedExit
  o.declinedTrust = false
  o.declinedExit = null
  if (was)
    return 'you chose not to trust this folder, so its session was stopped. Send a message to start it again and be asked again, or pick another folder'
  if (exit === 'bypass')
    return 'you chose not to run with permission checks off, so its session was stopped. Send a message to start it again and be asked again'
  if (exit === 'dev_channels')
    return 'you chose to exit instead of loading the development channel, so its session was stopped. Send a message to start it again and be asked again'
  return null
}

/** A session that runs was not ended by a "No": the marks of an answer that ended one are forgotten. */
export function forgetDeclined(o: OfferState): void {
  o.declinedTrust = false
  o.declinedExit = null
}

/** One worker as this module sees it: its id, its offer state, and the entry's `dialog`. */
export type OfferTarget = {
  id: string
  offer: OfferState
  dialog(): WorkerDialogT | undefined
  setDialog(d: WorkerDialogT | undefined): void
  /** The server names the thread folder's `.mcp.json` defines, for a question whose server name wrapped over rows (none: no names). */
  mcpNames?(): readonly string[]
}

/** What the answer needs of the pane (TmuxPtyHost has all of it). */
export interface DialogPane {
  visibleRows(): Promise<string[] | null>
  visibleRowsEscaped(): Promise<string[] | null>
  clientActivities(): Promise<number[] | null>
  sendDialogKey(key: PtyDialogKey, kind?: DialogKeyKind): Promise<PtySendResult>
}

export type DialogDeps = {
  home: string
  /** Monotonic seconds, and the wall clock in ms. */
  now(): number
  wallMs(): number
  audit(event: string, fields?: Record<string, string>): void
  /** The key of a device paired and not revoked in devices.json (DeviceStore.pinnedKey); undefined for any other. */
  pinnedKey(deviceId: string): JwkP256T | undefined
  sleep?(ms: number): Promise<void>
}

type Reason = 'screen_changed' | 'already_answered' | 'unverified'
type Outcome = { outcome: 'pressed' | 'nothing_pressed'; choice?: number; label?: string; reason?: Reason }
const nothing = (reason: Reason | null = 'screen_changed'): Outcome => ({
  outcome: 'nothing_pressed',
  ...(reason ? { reason } : {}),
})

/** How long an arrow gets to show (polls of ECHO_POLL_MS), and the pause between the tries of one read. */
const ECHO_POLLS = 40
const ECHO_POLL_MS = 50
const READ_TRIES = 3
const READ_PAUSE_MS = 100
/** The newest proofs kept: a proof is only good for 15 minutes anyway. */
const PROOFS_KEPT = 64
const PROOFS_MAX_BYTES = 64 * 1024

/** 16 random bytes, base64url: 128 bits, not guessable and not a time (22 characters, DialogId). */
export const newDialogId = (): string => randomBytes(16).toString('base64url')

/** A small regular file the other side writes: one open that refuses a link, then fstat; a link, a pipe or a big file is never read. */
export function readSmallFile(
  path: string,
  maxBytes: number,
): { kind: 'absent' | 'invalid' } | { kind: 'data'; text: string } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    return { kind: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid' }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) return { kind: 'invalid' }
    const buf = Buffer.alloc(maxBytes + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > maxBytes) return { kind: 'invalid' }
    return { kind: 'data', text: buf.subarray(0, n).toString('utf8') }
  } catch {
    return { kind: 'invalid' }
  } finally {
    closeSync(fd)
  }
}

const isRealFolder = (p: string) => {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Why `fresh` is not the dialog offered (null when it is): the kind, the labels in order, and the subject when the offer had one. */
export function dialogDiffers(offered: WorkerDialogT, fresh: Dialog): string | null {
  if (fresh.kind !== offered.kind) return 'kind_changed'
  if (!sameList(fresh.options, offered.options)) return 'options_changed'
  if (offered.subject !== null && fresh.subject !== offered.subject) return 'subject_changed'
  return null
}

/** Up or Down presses then Enter, from the CURRENT cursor row to `choice`; null when `fresh` is not the dialog offered. */
export function planKeys(offered: WorkerDialogT, fresh: Dialog | null, choice: number): PtyDialogKey[] | null {
  if (!fresh || dialogDiffers(offered, fresh) || offered.kind === 'login') return null
  if (choice < 0 || choice >= offered.options.length) return null
  const c = fresh.cursor
  if (c === null || c < 0 || c >= fresh.options.length) return null
  const d = choice - c
  return [...Array<PtyDialogKey>(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'), 'Enter']
}

export class WorkerDialogs {
  constructor(private readonly d: DialogDeps) {}

  private dir(id: string) {
    return workerDir(this.d.home, id)
  }

  /** `workers` and the thread's folder in it are folders themselves, not links. */
  folderIsReal(id: string): boolean {
    return isRealFolder(join(this.d.home, 'workers')) && isRealFolder(this.dir(id))
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  // ---- the offer --------------------------------------------------------------------------------------------------------

  /**
   * Once per look at a worker with a pane, before the notices. `seen` is the known dialog on a screen that has held still: an
   * unsettled screen changes nothing (the arrows of an answer redraw it), a settled one with no dialog ends the offer.
   */
  async sync(t: OfferTarget, pane: DialogPane, rows: string[], seen: Screen, settled: boolean): Promise<void> {
    const cur = t.dialog()
    if (seen.kind === 'none') {
      if (settled && cur) this.end(t)
      else if (!settled && cur && t.offer.sinceAwake !== null) t.offer.disturbed = true
      return
    }
    // colours too: the reader takes the Select Claude draws, not text that looks like one. A failed capture says nothing
    const escaped = await pane.visibleRowsEscaped()
    if (escaped === null) return
    const d = readDialog(rows, escaped, t.mcpNames?.() ?? [])
    if (!d) {
      if (!cur) return
      t.offer.misses++
      if (t.offer.misses >= 2) this.end(t)
      return
    }
    // login is a line only: no card, so nothing on offer. Nor a dialog whose subject cannot be read (a folder path wrapped over
    // rows, a consent with no name on its row, channels cut off): a card for it could be answered onto a lookalike that replaced
    // it, so the line is the way for those. The bypass disclaimer has no subject: its two exact rows are what tells it apart
    if (d.kind === 'login' || (d.kind !== 'bypass' && d.subject === null)) {
      if (cur) this.end(t)
      return
    }
    t.offer.misses = 0
    const nowMs = this.d.wallMs()
    const lifetimeMs = WORKER_TIMING.card_lifetime_s * 1000
    // The same dialog, still there, not pressed and not seen to change: one THIS supervisor offered. A record read back from disk
    // after a restart is never the same, however exactly it equals the screen: nobody was looking at the pane meanwhile (the
    // dialog can have been answered there and another that reads alike be in its place), so what is there now is a new sighting
    // with a new id, and a card or a tap for the old id applies to nothing (the Mac's WorkerDialogOffer.swift does the same).
    if (
      cur &&
      cur.kind === d.kind &&
      cur.subject === d.subject &&
      sameList(cur.options, d.options) &&
      !t.offer.disturbed &&
      t.offer.enterSentFor !== cur.id &&
      t.offer.sinceAwake !== null
    ) {
      if (cur.cursor !== d.cursor) t.setDialog({ ...cur, cursor: d.cursor })
      return
    }
    t.offer.declinedTrust = false
    t.offer.declinedExit = null
    t.setDialog({
      id: newDialogId(),
      kind: d.kind,
      subject: d.subject,
      options: d.options,
      cursor: d.cursor,
      seen_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + lifetimeMs).toISOString(),
    })
    t.offer.sinceAwake = this.d.now()
    t.offer.disturbed = false
    this.d.audit('worker_dialog_offered', { thread: t.id, kind: d.kind })
  }

  end(t: OfferTarget): void {
    if (!t.dialog()) return
    t.setDialog(undefined)
    t.offer.sinceAwake = null
    t.offer.misses = 0
    t.offer.disturbed = false
  }

  /** The thread's line for the dialog on offer waits: the bridge has a card for it, or has had less than DIALOG_CARD_WAIT_MS. */
  lineWaits(t: OfferTarget): boolean {
    const o = t.dialog()
    if (!o) return false
    if (this.folderIsReal(t.id)) {
      const f = readSmallFile(join(this.dir(t.id), WORKER_FILES.dialogCard), DIALOG_FILE_MAX_BYTES)
      if (f.kind === 'data' && parseDialogFile(DialogCardFile, f.text)?.dialog_id === o.id) return true
    }
    if (t.offer.sinceAwake === null) return false
    return this.d.now() - t.offer.sinceAwake < DIALOG_CARD_WAIT_MS / 1000
  }

  // ---- the answer -------------------------------------------------------------------------------------------------------

  /** Takes the answer file, once, and acts on it if it proves itself; always says what came of it in dialog-result.json. */
  async answer(t: OfferTarget, pane: DialogPane): Promise<void> {
    if (!this.folderIsReal(t.id)) return
    // only an offer THIS supervisor has seen on the screen: a record read back from workers.json is nothing to press on
    const offer = t.dialog()
    if (!offer || t.offer.sinceAwake === null) return this.answerLate(t)
    const a = this.take(t.id)
    if (!a || this.controlSeen(t, a.control_id)) return
    const o = await this.decide(t, pane, offer, a)
    this.d.audit('worker_dialog_answer', {
      thread: t.id,
      outcome: o.outcome,
      ...(o.reason ? { reason: o.reason } : {}),
    })
    this.writeResult(t.id, a, o)
  }

  /** The answer file renamed aside (a rewrite by the bridge lands in a new file), read, and removed. */
  private take(id: string): DialogAnswerT | null {
    const path = join(this.dir(id), WORKER_FILES.dialogAnswer)
    const taken = `${path}.taken`
    try {
      renameSync(path, taken)
    } catch {
      return null
    }
    const f = readSmallFile(taken, DIALOG_ANSWER_MAX_BYTES)
    rmSync(taken, { force: true })
    return f.kind === 'data' ? parseDialogFile(DialogAnswer, f.text) : null
  }

  /** Each control id once: in memory, and the one the last result was written for. Marks it seen. */
  private controlSeen(t: OfferTarget, controlId: string): boolean {
    if (t.offer.controlsSeen.includes(controlId)) return true
    const r = readSmallFile(join(this.dir(t.id), WORKER_FILES.dialogResult), DIALOG_FILE_MAX_BYTES)
    if (r.kind === 'data') {
      try {
        if ((JSON.parse(r.text) as { control_id?: unknown }).control_id === controlId) return true
      } catch {
        // not a result: nothing to compare
      }
    }
    t.offer.controlsSeen = [...t.offer.controlsSeen, controlId].slice(-64)
    return false
  }

  /**
   * An answer that comes with no dialog on offer, for the dialog this supervisor pressed already (it has left the pane since):
   * `already_answered`, so the bridge need not wait. Only an answer naming that dialog id is taken; any other is left alone.
   */
  private answerLate(t: OfferTarget): void {
    const pressed = t.offer.enterSentFor
    if (!pressed) return
    const path = join(this.dir(t.id), WORKER_FILES.dialogAnswer)
    const peek = readSmallFile(path, DIALOG_ANSWER_MAX_BYTES)
    if (peek.kind !== 'data' || parseDialogFile(DialogAnswer, peek.text)?.dialog_id !== pressed) return
    const a = this.take(t.id)
    if (!a || a.dialog_id !== pressed || !dialogFileFresh(a.at, this.d.wallMs())) return
    if (this.controlSeen(t, a.control_id)) return
    this.writeResult(t.id, a, nothing('already_answered'))
  }

  private async decide(t: OfferTarget, pane: DialogPane, offer: WorkerDialogT, a: DialogAnswerT): Promise<Outcome> {
    const nowMs = this.d.wallMs()
    if (!dialogFileFresh(a.at, nowMs)) return nothing('unverified')
    if (a.dialog_id !== offer.id) return nothing('unverified') // not the dialog on this pane
    if (!(nowMs < Date.parse(offer.expires_at))) return nothing()
    // the screen was seen to change under this offer: the dialog there now may not be the one the tap was for
    if (t.offer.disturbed) return nothing()
    // a signed tap is used once per dialog, whatever came of it (the control id is not signed), across a restart too
    const used = `${a.dialog_id}|${sha256Hex(a.proof.signed)}`
    const usedPath = join(this.dir(t.id), WORKER_FILES.dialogProofsUsed)
    if (t.offer.proofsUsed.includes(used) || readProofsUsed(usedPath).includes(used)) return nothing('already_answered')
    const v = await verifyDialogAnswer(a, {
      pinnedKey: (id) => this.d.pinnedKey(id),
      nowMs,
      thread: t.id,
      pane: { dialog_id: offer.id, dialog_kind: offer.kind, subject: offer.subject, options: offer.options },
      alreadyPressed: t.offer.enterSentFor === offer.id,
    })
    if (!v.ok) {
      this.d.audit('worker_dialog_unverified', { thread: t.id, step: String(v.step), why: v.why })
      return nothing(v.reason)
    }
    // on disk before anything is pressed: a copy of this tap is refused whatever happens next
    const all = [...new Set([...t.offer.proofsUsed, ...readProofsUsed(usedPath), used])].slice(-PROOFS_KEPT)
    t.offer.proofsUsed = all
    if (!this.folderIsReal(t.id)) return nothing(null)
    try {
      writeFileAtomic(usedPath, JSON.stringify({ used: all, v: 1 }), 0o600)
    } catch {
      return nothing(null) // not written, so not acted on
    }
    if (v.choice === null || v.label === null) return nothing(null) // login: never offered here
    return this.press(t, pane, offer, v.choice, v.label)
  }

  /** A key into a dialog is never sent on a guess: a client that typed lately, or a client list that cannot be read, blocks it. */
  private async typingBlocks(pane: DialogPane): Promise<boolean> {
    const c = await pane.clientActivities()
    if (c === null) return true
    if (c.length === 0) return false
    return this.d.wallMs() - Math.max(...c) < WORKER_TIMING.dialog_client_quiet_s * 1000
  }

  private async lookAtDialog(pane: DialogPane, names: readonly string[]): Promise<Dialog | null> {
    const plain = await pane.visibleRows()
    const coloured = await pane.visibleRowsEscaped()
    if (plain === null || coloured === null) return null
    return readDialog(plain, coloured, names)
  }

  /** The screen as readDialog reads it, with a few tries: the plain capture and the coloured one are two looks. */
  private async readFresh(pane: DialogPane, names: readonly string[]): Promise<Dialog | null> {
    for (let k = 0; k < READ_TRIES; k++) {
      if (k > 0) await this.sleep(READ_PAUSE_MS)
      const d = await this.lookAtDialog(pane, names)
      if (d) return d
    }
    return null
  }

  private async press(
    t: OfferTarget,
    pane: DialogPane,
    offer: WorkerDialogT,
    choice: number,
    chosen: string,
  ): Promise<Outcome> {
    const names = t.mcpNames?.() ?? []
    for (let step = 0; step <= offer.options.length; step++) {
      if (await this.typingBlocks(pane)) return nothing()
      const fresh = await this.readFresh(pane, names)
      const key = planKeys(offer, fresh, choice)?.[0]
      if (!key || !fresh || fresh.cursor === null) return nothing()
      if (key === 'Enter') {
        // the typing check, then the last look, then the Enter: only onto the signed choice's row, as just seen
        if (await this.typingBlocks(pane)) return nothing()
        const last = await this.readFresh(pane, names)
        if (!last || dialogDiffers(offer, last) || last.cursor === null || last.options[last.cursor] !== chosen)
          return nothing()
        // a timeout may have been delivered: counted, never repeated
        const sent = await pane.sendDialogKey('Enter', offer.kind as DialogKeyKind)
        if (keyNotSent(sent)) return nothing()
        t.offer.enterSentFor = offer.id
        // only a delivery the pane confirmed makes the exit that follows the owner's "No"; a timeout may or may not have landed
        if (offer.kind === 'trust' && !chosen.startsWith('Yes') && sent === 'sent') t.offer.declinedTrust = true
        // the other two questions whose "no" ends the session on its own: the disclaimer's "No, exit" and the channel's "Exit"
        if (sent === 'sent' && offer.kind === 'bypass' && !chosen.startsWith('Yes')) t.offer.declinedExit = 'bypass'
        if (sent === 'sent' && offer.kind === 'dev_channels' && chosen === 'Exit') t.offer.declinedExit = 'dev_channels'
        return { outcome: 'pressed', choice, label: chosen }
      }
      if (keyNotSent(await pane.sendDialogKey(key, offer.kind as DialogKeyKind))) return nothing()
      if (!(await this.moved(pane, offer, key, fresh.cursor, names))) return nothing()
    }
    return nothing()
  }

  /** The arrow shows: the same dialog with the highlighted row exactly one step on. A failed read is looked at again. */
  private async moved(
    pane: DialogPane,
    offer: WorkerDialogT,
    key: 'Up' | 'Down',
    from: number,
    names: readonly string[],
  ): Promise<boolean> {
    const to = key === 'Up' ? from - 1 : from + 1
    for (let k = 0; k < ECHO_POLLS; k++) {
      await this.sleep(ECHO_POLL_MS)
      const fresh = await this.lookAtDialog(pane, names)
      if (!fresh) continue
      if (dialogDiffers(offer, fresh)) return false
      if (fresh.cursor === to) return true
      if (fresh.cursor !== from) return false
    }
    return false
  }

  /** dialog-result.json, 0600, written atomically into a real folder. */
  private writeResult(id: string, a: DialogAnswerT, o: Outcome): void {
    if (!this.folderIsReal(id)) return
    const r = DialogResult.safeParse({
      v: 1,
      dialog_id: a.dialog_id,
      control_id: a.control_id,
      source: 'card',
      outcome: o.outcome,
      ...(o.choice !== undefined ? { choice: o.choice } : {}),
      ...(o.label !== undefined ? { label: o.label } : {}),
      ...(o.reason !== undefined ? { reason: o.reason } : {}),
      at: new Date(this.d.wallMs()).toISOString(),
    })
    if (!r.success) {
      this.d.audit('worker_bug', { thread: id, why: 'a dialog result that does not fit' })
      return
    }
    writeFileAtomic(join(this.dir(id), WORKER_FILES.dialogResult), JSON.stringify(r.data), 0o600)
  }
}

/** The signed taps already acted on; a file that is missing or does not fit reads as none. */
function readProofsUsed(path: string): string[] {
  const f = readSmallFile(path, PROOFS_MAX_BYTES)
  if (f.kind !== 'data') return []
  try {
    const o = JSON.parse(f.text) as { v?: unknown; used?: unknown }
    return o.v === 1 && Array.isArray(o.used) ? o.used.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}
