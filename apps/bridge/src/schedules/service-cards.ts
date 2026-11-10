// Schedule cards (S3.4, S6.1): preparing, publishing and applying them, and settling the ones a crash left open.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import {
  type ApplyResult,
  type CardBinding,
  type CardT,
  type ChronosChangeT,
  composeScheduleCard,
  type ErrorCodeT,
  fromChronosChange,
  newUlid,
  runsInSession,
  type ScheduleApproved,
  type ScheduleCardBase,
  ScheduleCardBindingError,
  ScheduleCardPayload,
  type ScheduleChangeT,
  toChronosChange,
  trustOn,
  type ValidateResult,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import { localClock } from '../clock-meta.ts'
import { defaultThreadRef, threadRef } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { TEST_REQUIRED_FIELD, testRequiredProblem } from '../heartbeat/tested.ts'
import { cardActionNotification, systemNotification } from '../notify.ts'
import { assertFrameFits, RelayRejectedError } from '../transport.ts'
import { localZone } from './discovery.ts'
import { shortWhen } from './format.ts'
import { heartbeatProblemOf } from './heartbeat-problem.ts'
import { applyTalosFields, memoryProblem } from './job-memory-run.ts'
import { proposerKey } from './kv-prune.ts'
import type { ScheduleService } from './service.ts'
import { isTalosOnly } from './service-shared.ts'
import { hasHeartbeatMeta } from './worker-scope.ts'

/**
 * validate -> compose -> ledger. Returns the card (not yet sent) or why not. The ledger row is `actor='bridge'`: only
 * those rows are ever applied by the bridge (S3.4).
 */
export async function prepareCard(
  this: ScheduleService,
  change: ScheduleChangeT,
  o: {
    proposedBy: 'agent' | 'owner_form'
    threadId: string
    origin: 'chat' | 'background'
    clientRef: string | null
    reason?: string
    supersedes?: string
    /** A thread's own session proposed it: the thread's name (the card names that session). */
    sessionName?: string
  },
): Promise<
  | { ok: true; card: CardT }
  | { ok: false; error: string; code?: ErrorCodeT; fields?: Array<{ path: string; message: string }> }
> {
  const old = this.tooOldFor(change)
  if (old)
    return {
      ok: false,
      error: old,
      code: 'schedule_invalid',
      fields: [{ path: old.includes('meta') ? 'meta' : 'when', message: old }],
    }
  const split = toChronosChange(change)
  if (change.op === 'create' && change.draft.thread_id && !this.ctx.config.thread(change.draft.thread_id))
    return {
      ok: false,
      error: 'unknown thread',
      code: 'schedule_invalid',
      fields: [{ path: 'draft.thread_id', message: `unknown thread ${change.draft.thread_id}` }],
    }
  let base: ScheduleCardBase | null = null
  let nextRuns: string[] = []
  let approved: ScheduleApproved | null = null
  if (change.op !== 'create') {
    const b = await this.baseOf(change.id)
    if (!b) return { ok: false, error: `no scheduled job "${change.id}"`, code: 'schedule_not_found' }
    base = b.base
    nextRuns = b.detail.next_runs
    if ((change.op === 'update' || change.op === 'delete') && base.schedule.etag !== change.base_etag)
      return { ok: false, error: 'The job changed on your Mac. Reload it and try again.', code: 'schedule_conflict' }
    if (change.op === 'adopt') {
      if (base.schedule.content_hash !== change.content_hash)
        return {
          ok: false,
          error: 'The job changed on your Mac again. Reload it and try again.',
          code: 'schedule_conflict',
        }
      const ap = await this.adapter.approved(change.id)
      approved = ap ? { prompt: ap.prompt, guard: ap.guard } : null
    }
  }
  // A heartbeat in the meta has to be one this Talos reads in full, on a job that fires at several times a day. This is the
  // one place the agent's propose tool, the owner's schedule.patch frame and an adopt all pass through, so no card ever
  // offers an unreadable or unknown-kind heartbeat for approval (HB1b).
  const hbProblem = heartbeatProblemOf(change, base, defaultThreadRef(this.ctx).id)
  if (hbProblem)
    return { ok: false, error: hbProblem, code: 'schedule_invalid', fields: [{ path: 'meta', message: hbProblem }] }
  const memProblem = memoryProblem(change, base)
  if (memProblem)
    return {
      ok: false,
      error: memProblem,
      code: 'schedule_invalid',
      fields: [{ path: 'memory', message: memProblem }],
    }
  // test_required (docs/HEARTBEAT.md): a heartbeat that ends up ON needs a passing test of these exact settings, whichever door it came by.
  const needTest = testRequiredProblem(this.ctx.paths.home, this.now(), change, base)
  if (needTest)
    return {
      ok: false,
      error: needTest,
      code: 'schedule_invalid',
      fields: [{ path: TEST_REQUIRED_FIELD, message: needTest }],
    }
  // Only the result thread changes (a Talos-only field): Chronos has nothing to validate or write, and refuses an empty change.
  const threadOnly = isTalosOnly(split)
  if (change.op === 'update' && change.set.thread_id && !this.ctx.config.thread(change.set.thread_id))
    return {
      ok: false,
      error: 'unknown thread',
      code: 'schedule_invalid',
      fields: [{ path: 'set.thread_id', message: `unknown thread ${change.set.thread_id}` }],
    }
  const v: ValidateResult =
    threadOnly && base
      ? {
          ok: true,
          normalized: split.chronos,
          preview: {
            when_text: base.schedule.when_text.slice(0, 120),
            next_runs: nextRuns,
            tz: this.lastGood?.health.tz ?? localZone(this.ctx.env),
          },
          expectedEtag: base.schedule.etag,
        }
      : await this.adapter.validate(split.chronos)
  if (!v.ok) {
    const text = v.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')
    return { ok: false, error: `${v.code}: ${text}`, code: v.code, fields: v.errors }
  }
  const final = fromChronosChange(v.normalized, split.threadId, split.memory)
  const now = this.iso()
  let card: CardT
  try {
    card = composeScheduleCard(final, v.preview, approved, {
      cardId: `c_${newUlid()}`,
      threadId: o.threadId,
      now,
      origin: o.origin,
      proposedBy: o.proposedBy,
      agentName: this.ctx.config.config.agent.name,
      expectedEtag: v.expectedEtag,
      clientRef: o.clientRef,
      threadName: (t) =>
        t
          ? (this.ctx.config.thread(t)?.name ?? t)
          : (this.ctx.config.thread(this.ctx.config.config.default_thread)?.name ?? 'Default'),
      base,
      ...(trustOn(this.ctx.config.config) ? { trust: true } : {}),
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.supersedes ? { supersedes: o.supersedes } : {}),
      ...(o.sessionName ? { sessionName: o.sessionName } : {}),
      chronosMemory: this.chronosMemoryState(),
    })
  } catch (e) {
    if (e instanceof ScheduleCardBindingError) return { ok: false, error: e.message, code: 'schedule_conflict' }
    throw e
  }
  try {
    assertFrameFits(cardCreateFrame(this.now(), card))
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'too_large' }
  }
  this.ctx.ledger.create(card, 'bridge')
  return { ok: true, card }
}

/** Sends card.create (the ledger row exists first, so a resolve can never beat it). */
export async function publishCard(this: ScheduleService, card: CardT) {
  const { ctx } = this
  try {
    await ctx.transport.sendDurable(cardCreateFrame(this.now(), card))
  } catch (e) {
    if (e instanceof RelayRejectedError) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      this.forgetCard(card.id)
    }
    throw e
  }
  if (card.supersedes && ctx.ledger.supersede(card.supersedes)) {
    ctx.expiry?.cancel(card.supersedes)
    this.forgetCard(card.supersedes)
    ctx.transport
      .sendDurable(cardUpdateFrame(this.now(), { card_id: card.supersedes, state: 'superseded', reason: 'superseded' }))
      .catch((e) => this.log('card.update not sent', { error: (e as Error).message }))
  }
  ctx.expiry?.sync()
}

/** The owner pressed a button on a bridge-owned card (inbound has run the SPEC 4.5 checks). */
export function onCardResolved(
  this: ScheduleService,
  row: LedgerRow,
  action: 'primary' | 'kill' | 'revise',
  approved: CardBinding,
  cardId: string,
  note?: string,
) {
  const payload = ScheduleCardPayload.safeParse(approved.payload)
  const byAgent = payload.success && payload.data.proposed_by === 'agent'
  if (action !== 'primary') {
    this.forgetCard(cardId) // declined or sent back: nothing will read who proposed it
    if (byAgent) {
      // KILL and REVISE reach the agent like any card, with the owner's note: REVISE is how they steer a proposal (S8.2)
      void this.ctx.emit(
        cardActionNotification({
          thread: threadRef(this.ctx, row.thread_id),
          card: { id: cardId, title: row.binding.title, primary_label: row.binding.primary_label },
          action,
          ts: this.iso(),
          note,
          clock: localClock(this.ctx, this.iso()),
        }),
      )
    }
    return
  }
  void this.enqueue(() => this.applyCard(row, approved, cardId)).catch((e) =>
    this.log('schedule apply failed', { card: cardId, error: (e as Error).message }),
  )
}

/** S3.4: split, write under Chronos's lock, check the etag, write the sidecar, report. */
export async function applyCard(this: ScheduleService, row: LedgerRow, approved: CardBinding, cardId: string) {
  let ended = false
  const finish = async (ok: boolean, text: string) => {
    ended = true
    await this.endCard(row, cardId, ok, text)
  }
  try {
    await this.applyCardInner(approved, finish)
  } catch (e) {
    this.log('schedule apply failed', { card: cardId, error: (e as Error).message })
    // A slow, killed or unreadable Chronos write must still END the card. Chronos may have written before it was cut off,
    // so the text says "check it", not "nothing saved" (review R1).
    if (!ended)
      await finish(
        false,
        "The scheduler didn't answer in time, so this may or may not have been saved. Check it in Schedules, then ask again.",
      )
  }
}

/** The card's last word: ledger, card.update, a refresh, and the agent told. Only the bridge's own write path calls it. */
export async function endCard(this: ScheduleService, row: LedgerRow, cardId: string, ok: boolean, text: string) {
  const { ctx } = this
  ctx.ledger.finish(cardId, ok)
  this.forgetCard(cardId)
  await ctx.transport
    .sendDurable(
      cardUpdateFrame(this.now(), {
        card_id: cardId,
        state: ok ? 'done' : 'failed',
        result: { ok, text, at: this.iso() },
      }),
    )
    .catch((e) => this.log('card.update not sent', { error: (e as Error).message }))
  this.chronos()?.invalidate()
  await this.refresh().catch(() => {})
  await ctx
    .emit(
      systemNotification({
        thread: threadRef(ctx, row.thread_id),
        text: `Card ${cardId} → PRIMARY. The bridge applied it: ${text} Nothing for you to do.`,
        ts: this.iso(),
        id: `${cardId}-applied`,
      }),
    )
    .catch(() => {})
}

export async function applyCardInner(
  this: ScheduleService,
  approved: CardBinding,
  finish: (ok: boolean, text: string) => Promise<void>,
) {
  const { ctx } = this
  const cardId = approved.id
  const p = ScheduleCardPayload.safeParse(approved.payload)
  if (!p.success) return finish(false, 'The card could not be read. Nothing was saved. Ask again.')
  // Fail closed (S3.7): a card drawn while Talos managed the registry must not write once Chronos stopped enforcing approval
  this.chronos()?.invalidate()
  if (!this.managed(await this.safeSnapshot()))
    return finish(
      false,
      'Talos no longer manages this scheduler (approval is off at the Mac). Nothing was saved. Run `talos-app schedules adopt` at the Mac, then ask again.',
    )
  const { change, expected_etag: expected, preview } = p.data
  const split = toChronosChange(change)
  const d = await this.ensure()
  if (d.state !== 'ready') return finish(false, 'The scheduler is not available. Nothing was saved. Ask again.')
  // A thread session's change or delete is the owner's approval of THAT thread's job: if the job moved, was switched to a
  // background runner or became a heartbeat since the card was drawn, it is no longer what was shown.
  const recorded = ctx.store.kvGet(proposerKey(cardId))
  const proposer = this.cardProposer(cardId)
  if (change.op === 'update' || change.op === 'delete') {
    const cur = await d.adapter.detail(change.id, null).catch(() => null)
    const j = cur?.detail.schedule
    // No row at all (lost, or a card from before the rows were kept for main) cannot be told from a thread session's card
    // whose scope check was skipped: for a job that runs in a session, fail closed.
    if (recorded === undefined && j && runsInSession(j) && j.kind !== 'command' && !hasHeartbeatMeta(j.meta))
      return finish(false, "Nothing was changed: this card's origin can't be checked. Ask again.")
    if (proposer && j && !this.inScope({ thread: proposer }, j))
      return finish(false, 'This job moved to another thread; nothing changed.')
  }
  // The test that let this card be drawn may be a day old by the time it is approved: ask again, against the job as it is now.
  const baseNow = change.op === 'create' ? null : ((await this.baseOf(change.id).catch(() => null))?.base ?? null)
  const needTest = testRequiredProblem(ctx.paths.home, this.now(), change, baseNow)
  if (needTest)
    return finish(false, needTest.replace('Nothing was saved.', 'Nothing was saved. Test again, then ask again.'))
  let r: ApplyResult
  if (isTalosOnly(split) && change.op === 'update') {
    // nothing for Chronos to write: confirm the job is still the revision the card showed, then only the sidecar changes
    const x = await d.adapter.detail(change.id, null)
    r = !x
      ? { ok: false, code: 'schedule_not_found', message: 'gone' }
      : x.detail.schedule.etag !== change.base_etag
        ? { ok: false, code: 'schedule_conflict', message: 'moved' }
        : { ok: true, etag: x.detail.schedule.etag }
  } else r = await d.adapter.apply(split.chronos as ChronosChangeT, expected)
  if (!r.ok) {
    const text: Record<string, string> = {
      schedule_conflict: 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.',
      schedule_invalid: 'The scheduler no longer accepts this change as drawn. Nothing was saved. Ask again.',
      held: 'The job is on hold because its files changed outside the app. Nothing was saved. Review it in Schedules.',
      schedule_not_found: 'The job no longer exists. Nothing was saved.',
    }
    return finish(false, text[r.code] ?? 'Nothing was saved. Ask again.')
  }
  if (r.etag !== expected) {
    // Chronos wrote under its own lock, so the record is whatever it wrote: report it, never trust it.
    ctx.log.security('schedule apply produced an unexpected etag', {
      card_id: cardId,
      job: 'id' in change ? change.id : change.draft.id,
    })
    return finish(false, 'The job was written, but not as the card showed. Check it in Schedules.')
  }
  const id = change.op === 'create' ? change.draft.id : change.id
  let sideErr = ''
  let memErr = ''
  try {
    const side = applyTalosFields(this.jobMemory, this.sidecar, id, change, split)
    sideErr = side.thread
    memErr = side.memory
  } catch (e) {
    sideErr = (e as Error).message
  }
  let text: string
  if (change.op === 'delete') text = 'Deleted.'
  else {
    const x = await d.adapter.detail(id, null).catch(() => null)
    const next = x?.detail.next_runs[0] ?? preview.next_runs[0]
    const tz = x ? (this.lastGood?.health.tz ?? preview.tz) : preview.tz
    text = change.op === 'adopt' ? 'Approved as it is on disk.' : 'Saved.'
    if (next) text += ` Next run ${shortWhen(next, tz)}.`
  }
  if (sideErr) text = `${text.replace(/\.$/, '')}. Result thread not set (${sideErr}).`
  if (memErr) text = `${text.replace(/\.$/, '')}. Memory setting not saved (${memErr}).`
  return finish(true, text)
}

/** A restart can leave an approved card between "resolved" and "done"; it must not hang there. */
export async function failStuckCards(this: ScheduleService) {
  if (this.stopped) return
  for (const row of this.ctx.ledger.list('resolved')) {
    if (row.actor !== 'bridge' || row.resolution?.action !== 'primary') continue
    if (this.ctx.apps?.isRunning(row.id)) continue // an app card whose tool this process is running right now
    if (row.binding.kind === 'config') continue // a settings card: ConfigProposals.recover() reads the config and says what is true
    if (row.binding.kind === 'dialog') continue // the dialog-card service settles its own cards after a restart
    if (!this.ctx.ledger.finish(row.id, false)) continue // closed by someone else meanwhile: say nothing more
    await this.ctx.transport
      .sendDurable(
        cardUpdateFrame(this.now(), {
          card_id: row.id,
          state: 'failed',
          result: {
            ok: false,
            text:
              row.binding.kind === 'app_action'
                ? 'The bridge restarted before this finished. It may not have run. Check before asking again.'
                : 'The bridge restarted before this was saved. Check it in Schedules, then ask again.',
            ...(row.binding.kind === 'app_action' ? { ran: 'unknown' as const } : {}),
            at: this.iso(),
          },
        }),
      )
      .catch(() => {})
  }
}
