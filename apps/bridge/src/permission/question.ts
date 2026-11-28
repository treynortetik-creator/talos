// An open AskUserQuestion, mirrored on the phone (item 6; docs/CLAUDE-CODE.md C3.7a). Claude Code runs the PermissionRequest hook for it
// (kit/hooks/permission-relay.py), and a hook that answers `allow` with `updatedInput.answers` completes the tool WITHOUT the pane, so
// the phone's answer and the unblock below are both just the hook's answer.
//   - AT ONCE one `dialog` card per question in the agent's thread (Main: the default thread): the question, its options as buttons and an
//     "Other" button that takes the owner's words. The owner's signed card.resolve answers it (first answer wins); a multi-select
//     question is offered here as a single choice.
//   - When every question has an answer the hook gets them. If some are still unanswered after `unblockMs` (ten minutes) the hook is answered
//     with exactly NO_ANSWER_YET for those, so the agent can go on with other work (and its queued channel messages); the cards expire and a
//     late tap finds a closed card.
//   - A question answered at the terminal ends the hook: the cards close, the timer is cancelled, nothing is sent.
// Permission prompts are NOT touched here and never fail closed.
import {
  type CardT,
  cleanDialogText,
  clipUnits,
  composeDialogCard,
  DIALOG_LABEL_MAX,
  DIALOG_SUBJECT_MAX,
  dialogVisibleText,
  newId,
  newUlid,
  type WorkerDialogT,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { threadRef } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { assertFrameFits } from '../transport.ts'
import { NO_ANSWER_YET, OTHER_LABEL, SENT_TEXT } from './question-words.ts'
import type { HookDecision, HookRequest } from './relay.ts'

/** How long a question may wait for the phone before the agent is unblocked. */
export const QUESTION_UNBLOCK_MS = 10 * 60_000

export type AskedQuestion = { question: string; options: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The questions of an AskUserQuestion input, or undefined when it is not the shape Claude Code sends (1 to 4 questions, 2 to 4 labelled options each). */
export function parseQuestions(input: unknown): AskedQuestion[] | undefined {
  if (!isObj(input) || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4)
    return undefined
  const out: AskedQuestion[] = []
  for (const q of input.questions) {
    if (!isObj(q) || typeof q.question !== 'string' || q.question.trim() === '' || !Array.isArray(q.options))
      return undefined
    if (q.options.length < 2 || q.options.length > 4) return undefined
    const options: string[] = []
    for (const o of q.options) {
      if (!isObj(o) || typeof o.label !== 'string' || o.label.trim() === '') return undefined
      options.push(o.label)
    }
    out.push({ question: q.question, options })
  }
  return out
}

type Ask = {
  thread: string
  questions: AskedQuestion[]
  /** card id -> the index of its question */
  cards: Map<string, number>
  answers: Map<number, string>
  timer: unknown
  done: boolean
  finish(d: HookDecision): void
}

export type QuestionPrecheck =
  | { handled: false }
  | { handled: true; ok: true; choice: number | null; text?: string | undefined }
  | { handled: true; ok: false; code: 'bad_frame' | 'card_not_pending'; reason: string }

const DIALOG_PREFIX = 'ask'
/** How long after an ask ends the pane reader still makes no card for the same question. */
const RECENT_MS = 8_000

export class QuestionAsks {
  private unblockMs = QUESTION_UNBLOCK_MS
  private readonly byCard = new Map<string, Ask>()
  /** thread -> when its last ask ended */
  private readonly finished = new Map<string, number>()

  constructor(private readonly ctx: BridgeContext) {}

  setUnblockMs(ms: number) {
    this.unblockMs = ms
  }

  /**
   * Is a question of this thread waiting on the phone, or was one answered in the last few seconds? (The Mac's pane reader then makes no
   * second card for it: the screen still shows the question for a moment after the answer.)
   */
  pendingFor(thread: string): boolean {
    for (const a of this.byCard.values()) if (!a.done && a.thread === thread && a.cards.size > 0) return true
    const at = this.finished.get(thread)
    return at !== undefined && this.ctx.clock.now() - at < RECENT_MS
  }

  /** A card of ours? (By the dialog id we gave it, so a card left by an earlier run is ours too, and is refused as no longer waiting.) */
  private isOurs(row: LedgerRow): boolean {
    const p = row.binding.payload as { dialog_id?: unknown; dialog_kind?: unknown } | null | undefined
    return (
      row.binding.kind === 'dialog' &&
      p?.dialog_kind === 'agent_question' &&
      typeof p.dialog_id === 'string' &&
      p.dialog_id.startsWith(DIALOG_PREFIX)
    )
  }

  /** Makes the cards at once and waits for the answers. Never throws; `none` leaves the question at the terminal. */
  async ask(req: HookRequest, questions: AskedQuestion[], signal: AbortSignal): Promise<HookDecision> {
    const { ctx } = this
    const none = (reason: string): HookDecision => ({ decision: 'none', reason })
    const thread = req.thread ?? ctx.config.config.default_thread
    if (!ctx.config.thread(thread)) return none('no_thread')
    if (signal.aborted) return none('hook_gone')
    const now = ctx.clock.now()
    const cards: { card: CardT; index: number }[] = []
    for (const [index, q] of questions.entries()) {
      // the question is only SHOWN: hidden and control characters become visible markers, it is clipped, and it is never refused (the answer
      // goes back by position, so what the card says plays no part in it)
      const subject = clipUnits(dialogVisibleText(q.question).trim(), DIALOG_SUBJECT_MAX)
      const options = [...q.options.map((o) => clipUnits(o, DIALOG_LABEL_MAX)), OTHER_LABEL]
      const dialog: WorkerDialogT = {
        id: `${DIALOG_PREFIX}${newUlid()}`,
        kind: 'agent_question',
        subject,
        options,
        cursor: null,
        free_text: options.length - 1,
        seen_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.unblockMs + 120_000).toISOString(),
      }
      const card = composeDialogCard({
        card_id: newId('c'),
        dialog,
        thread_id: thread,
        thread_name: req.thread === undefined ? 'Main' : threadRef(ctx, thread).name,
        now,
        main: req.thread === undefined,
      })
      // a question no card can be made for is left to the terminal, but the agent is still released by the timer below
      if (card) cards.push({ card, index })
    }
    let finish: (d: HookDecision) => void = () => {}
    const decided = new Promise<HookDecision>((resolve) => {
      finish = resolve
    })
    const ask: Ask = {
      thread,
      questions,
      cards: new Map(cards.map((c) => [c.card.id, c.index])),
      answers: new Map(),
      timer: undefined,
      done: false,
      finish,
    }
    // the timer runs from the start, whatever happens to the cards: the agent is ALWAYS released after `unblockMs`
    ask.timer = ctx.clock.setTimeout(() => this.unblock(ask), this.unblockMs)
    const onAbort = () => {
      this.close(ask, signal.reason === 'prompt_over' ? 'prompt_over' : 'hook_gone')
      finish(none(signal.reason === 'prompt_over' ? 'prompt_over' : 'hook_gone'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (const c of cards) assertFrameFits(cardCreateFrame(now, c.card))
      for (const c of cards) {
        ctx.ledger.create(c.card, 'bridge')
        this.byCard.set(c.card.id, ask)
      }
      // sent at once, all together; if a card cannot be sent the others are taken back and the question waits for the timer alone
      const sent = await Promise.all(
        cards.map((c) =>
          Promise.resolve(ctx.transport.sendDurable(cardCreateFrame(now, c.card))).then(
            () => true,
            () => false,
          ),
        ),
      )
      if (!ask.done && sent.some((ok) => !ok)) this.dropCards(ask, 'send_failed')
      else ctx.expiry?.sync()
    } catch (e) {
      ctx.log.warn('question cards not made', { error: (e as Error).message })
      this.dropCards(ask, 'send_failed')
    }
    const d = await decided
    signal.removeEventListener('abort', onAbort)
    return d
  }

  /** Ten minutes passed: the questions nobody answered get the fixed words, the agent goes on, the cards close. Once. */
  private unblock(ask: Ask) {
    if (ask.done) return
    const answers = this.collect(ask, NO_ANSWER_YET)
    this.close(ask, 'unblocked')
    ask.finish({ decision: 'answer', reason: 'unblocked', answers })
  }

  private collect(ask: Ask, fill: string | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < ask.questions.length; i++) {
      const a = ask.answers.get(i) ?? fill
      if (a !== undefined) out[String(i)] = a
    }
    return out
  }

  /** Ends the ask: its timer, its still-open cards (expired with `reason`), its place in the table. */
  private close(ask: Ask, reason: string) {
    if (ask.done) return
    ask.done = true
    this.ctx.clock.clearTimeout(ask.timer)
    this.dropCards(ask, reason)
    this.finished.set(ask.thread, this.ctx.clock.now())
  }

  /** Takes the ask's cards back (still-open ones expire with `reason`); the ask itself goes on. */
  private dropCards(ask: Ask, reason: string) {
    const { ctx } = this
    for (const id of ask.cards.keys()) {
      this.byCard.delete(id)
      const row = ctx.ledger.get(id)
      if (!row || row.state !== 'pending') continue
      if (!ctx.ledger.expire(id)) continue
      ctx.expiry?.cancel(id)
      ctx.transport
        .sendDurable(cardUpdateFrame(ctx.clock.now(), { card_id: id, state: 'expired', reason }))
        .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    }
    ask.cards.clear()
  }

  /** Closes every open question (the bridge is stopping): the hooks then end with no answer and the prompts stay. */
  closeAll() {
    for (const ask of new Set(this.byCard.values())) {
      this.close(ask, 'bridge_stopped')
      ask.finish({ decision: 'none', reason: 'bridge_stopped' })
    }
  }

  /**
   * Before the ledger sees a card.resolve: for a card of ours, only a primary tap on one of its buttons counts, the words only on "Other"
   * and nothing else. A card of ours whose question is no longer waiting (an earlier run, an unblocked ask) is refused and closed.
   */
  precheck(f: {
    card_id: string
    action: 'primary' | 'kill' | 'revise'
    choice?: number | undefined
    text?: string | undefined
    edited?: unknown
  }): QuestionPrecheck {
    const row = this.ctx.ledger.get(f.card_id)
    if (!row || !this.isOurs(row)) return { handled: false }
    // a card that is not pending any more is left to the ledger, which says so (first answer wins, or expired)
    if (row.state !== 'pending') return { handled: true, ok: true, choice: f.choice ?? null }
    const ask = this.byCard.get(f.card_id)
    if (!ask || ask.done) {
      if (this.ctx.ledger.expire(f.card_id)) this.ctx.expiry?.cancel(f.card_id)
      return {
        handled: true,
        ok: false,
        code: 'card_not_pending',
        reason: "The session isn't waiting on this any more.",
      }
    }
    const bad = (reason: string): QuestionPrecheck => ({ handled: true, ok: false, code: 'bad_frame', reason })
    const p = row.binding.payload as { options?: string[]; free_text?: number }
    const n = p.options?.length ?? 0
    if (f.action !== 'primary' || f.edited !== undefined) return bad('This card is answered with a button.')
    if (f.choice === undefined || f.choice >= n) return bad('That is not one of the buttons on this card.')
    if (f.choice === p.free_text) {
      if (f.text === undefined || cleanDialogText(f.text) !== f.text) return bad('Type your answer in the box.')
    } else if (f.text !== undefined) return bad('That button takes no text.')
    return { handled: true, ok: true, choice: f.choice, text: f.text }
  }

  /** The owner's signed answer was accepted by the ledger: it becomes the question's answer; the last one releases the hook. */
  onResolved(row: LedgerRow, choice: number | null, text: string | undefined) {
    const { ctx } = this
    const ask = this.byCard.get(row.id)
    this.byCard.delete(row.id)
    if (!ask || ask.done) return
    const index = ask.cards.get(row.id)
    const p = row.binding.payload as { options?: string[]; free_text?: number }
    if (index === undefined || choice === null) return
    const label = choice === p.free_text ? text : p.options?.[choice]
    if (label === undefined) return
    ask.answers.set(index, label)
    ctx.ledger.finish(row.id, true)
    ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: 'done',
          result: { ok: true, text: SENT_TEXT, at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    if (ask.answers.size < ask.questions.length) return
    const answers = this.collect(ask, undefined)
    this.close(ask, 'answered')
    ask.finish({ decision: 'answer', reason: 'owner', answers })
  }
}
