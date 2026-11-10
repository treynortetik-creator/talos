// The agent's propose tool (S6.1): validate a proposal and turn it into a change.
// Moved out of service.ts unchanged; each function runs with `this` set to the ScheduleService.
import {
  changeNeedsSchedulesV2,
  type MessageT,
  type ScheduleCardBase,
  ScheduleCardPayload,
  ScheduleChange,
  type ScheduleChangeT,
  type ScheduleDetailT,
} from '@talos-app/protocol'
import { threadRef } from '../context.ts'
import { handoffSince } from '../worker/handoff.ts'
import type { ClosedAdapter } from './closed-adapter.ts'
import { proposerKey } from './kv-prune.ts'
import type { ScheduleService } from './service.ts'
import {
  fail,
  MAIN_PROPOSER,
  MAX_PENDING_SCHEDULE_CARDS,
  OWNER_SPOKE_MS,
  PROPOSALS_PER_HOUR,
  type ToolOut,
  yes,
  zodText,
} from './service-shared.ts'
import { notYourJob, pendingFor, type WorkerScope } from './worker-scope.ts'

/** The agent's proposal: validate, then mint a card (S6.1). It never writes the registry. */
export function toolPropose(
  this: ScheduleService,
  args: Record<string, unknown>,
  scope?: WorkerScope,
): Promise<ToolOut> {
  return this.enqueue(async () => {
    const d = await this.ensure()
    if (d.state !== 'ready') return fail((d.adapter as ClosedAdapter).agentText())
    if (!this.relaySupports())
      return fail(
        "The relay doesn't support Schedules yet. Ask the owner to update the relay first; nothing was proposed.",
      )
    const snap = this.lastGood ?? (await this.safeSnapshot())
    if (!this.managed(snap))
      return fail(
        'Talos does not manage this scheduler yet. Tell the owner to run `talos-app schedules adopt` at the Mac.',
      )
    const now = this.now()
    const lane = scope?.thread ?? 'main'
    const recent = (this.proposalAt.get(lane) ?? []).filter((t) => now - t < 3600_000)
    this.proposalAt.set(lane, recent)
    if (recent.length >= PROPOSALS_PER_HOUR)
      return fail(`At most ${PROPOSALS_PER_HOUR} proposals an hour. Ask the owner what they want and propose once.`)
    // main and each thread session count their own waiting cards: one looping session cannot fill main's allowance
    const pending = this.ctx.ledger
      .list('pending')
      .filter(
        (r) =>
          r.actor === 'bridge' && r.binding.kind === 'schedule' && this.cardProposer(r.id) === (scope?.thread ?? null),
      )
    if (scope) {
      const busy = pendingFor(pending.length, scope)
      if (busy) return fail(busy)
    } else if (pending.length >= MAX_PENDING_SCHEDULE_CARDS)
      return fail(
        `There are already ${MAX_PENDING_SCHEDULE_CARDS} schedule cards waiting for the owner. Wait for them.`,
      )
    const built = await this.changeFromArgs(args, scope)
    if (!built.ok) return fail(built.error)
    if (changeNeedsSchedulesV2(built.change) && !this.relaySupportsV2())
      return fail(
        "The relay doesn't support schedules/2 yet (several fire times, meta). Ask the owner to update the relay first; nothing was proposed.",
      )
    const origin = this.agentOrigin(built.threadId)
    const minted = await this.prepareCard(built.change, {
      proposedBy: 'agent',
      threadId: built.threadId,
      origin,
      clientRef: null,
      reason: built.reason,
      ...(scope ? { sessionName: threadRef(this.ctx, scope.thread).name } : {}),
      ...(built.supersedes ? { supersedes: built.supersedes } : {}),
    })
    if (!minted.ok) return fail(minted.error)
    recent.push(now)
    // who proposed it, kept beside the card: supersede, the pending count and the apply-time check read it
    this.ctx.store.kvSet(proposerKey(minted.card.id), scope?.thread ?? MAIN_PROPOSER)
    await this.publishCard(minted.card)
    return yes(`card ${minted.card.id} pending, expires ${minted.card.expires_at}`)
  })
}

/**
 * 'chat' when the owner spoke in that thread a moment ago (the proposal answers them), else 'background' (S8.2).
 * Two kinds of owner row are NOT the owner speaking: a token share (via 'share') and a signed share sent with no note
 * (shared material only; docs/V2-FEATURES.md V4.7, "the only owner words are a typed note"). And the agent chooses the
 * thread it proposes into, so the owner's words in `general` must not vouch for a proposal an untrusted share in `inbox`
 * steered: if a share-only row arrived in ANOTHER thread after the owner's last words, the proposal is 'background'.
 */
export function agentOrigin(this: ScheduleService, threadId: string): 'chat' | 'background' {
  const now = this.now()
  const rows = this.ctx.store.ownerRowsSince(new Date(now - OWNER_SPOKE_MS).toISOString(), 200)
  const shareOnly = (m: MessageT) => m.via === 'share' || (m.share_content !== undefined && !(m.text ?? '').trim())
  let spoke = -Infinity
  for (const m of rows) {
    if (m.thread_id !== threadId || shareOnly(m)) continue
    const t = Date.parse(m.created_at)
    if (now - t < OWNER_SPOKE_MS && t > spoke) spoke = t
  }
  if (spoke === -Infinity) return 'background'
  // A hand-off between sessions after the owner's words is not the owner speaking
  if (handoffSince(this.ctx.store.db, spoke, now)) return 'background'
  // Only a share in ANOTHER thread counts: the agent proposing into the thread where the owner spoke is answering them
  // (a share landing in that same thread was judged earlier, review-share-p1, and stays a chat card).
  return rows.some((m) => m.thread_id !== threadId && shareOnly(m) && Date.parse(m.created_at) > spoke)
    ? 'background'
    : 'chat'
}

export async function changeFromArgs(
  this: ScheduleService,
  a: Record<string, unknown>,
  scope?: WorkerScope,
): Promise<
  | { ok: true; change: ScheduleChangeT; threadId: string; reason: string; supersedes?: string }
  | { ok: false; error: string }
> {
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)
  const op = str('op')
  const threadId = str('thread_id') ?? str('chat_id')
  if (!threadId || !this.ctx.config.thread(threadId))
    return {
      ok: false,
      error: `Unknown thread "${threadId ?? ''}". Valid thread ids: ${this.ctx.config.threadIds().join(', ')}`,
    }
  const reason = (str('reason') ?? '').slice(0, 280)
  if (!reason) return { ok: false, error: 'reason is required (up to 280 characters): say why you are proposing this' }
  const supersedes = str('supersedes')
  if (supersedes !== undefined) {
    const old = this.ctx.ledger.get(supersedes)
    const mine = ScheduleCardPayload.safeParse(old?.binding.payload)
    if (old?.actor !== 'bridge' || old.state !== 'pending' || !mine.success || mine.data.proposed_by !== 'agent')
      return { ok: false, error: 'supersedes can only replace one of your own pending schedule proposals' }
    if (scope && (old.thread_id !== scope.thread || this.cardProposer(supersedes) !== scope.thread))
      return { ok: false, error: 'supersedes can only replace one of your own pending schedule proposals' }
  }
  const resultThread = str('result_thread_id')
  if (resultThread !== undefined && !this.ctx.config.thread(resultThread))
    return {
      ok: false,
      error: `Unknown result_thread_id "${resultThread}". Valid thread ids: ${this.ctx.config.threadIds().join(', ')}`,
    }
  const extra = { threadId, reason, ...(supersedes ? { supersedes } : {}) }
  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
  if (op === 'create') {
    const name = str('name')
    const id = str('id') ?? (name ? slug(name) : undefined)
    const draft = {
      id,
      name,
      description: str('description') ?? '',
      when: a.when,
      catchup_min: typeof a.catchup_min === 'number' ? a.catchup_min : 180,
      enabled: typeof a.enabled === 'boolean' ? a.enabled : true,
      runner: str('runner') ?? 'session',
      permissions: str('permissions') ?? 'full',
      allowed_tools: Array.isArray(a.allowed_tools) ? a.allowed_tools : [],
      model: a.model === undefined ? null : a.model,
      notify: str('notify') ?? 'failure',
      thread_id: resultThread ?? null,
      prompt: str('prompt'),
      ...(a.meta !== undefined ? { meta: a.meta } : {}),
      ...(a.memory !== undefined ? { memory: a.memory } : {}),
    }
    const parsed = ScheduleChange.safeParse({ op: 'create', draft })
    if (!parsed.success) return { ok: false, error: zodText(parsed.error) }
    return { ok: true, change: parsed.data, ...extra }
  }
  if (op === 'update' || op === 'delete') {
    const id = str('id')
    if (!id) return { ok: false, error: `id is required for ${op}` }
    const x = await this.adapter.detail(id, null)
    if (!x) return { ok: false, error: `schedule_not_found: no scheduled job "${id}"` }
    // checked on the job as it is NOW, inside the schedule queue: a thread session changes only its own thread's jobs
    if (scope && !this.inScope(scope, x.detail.schedule)) return { ok: false, error: notYourJob(scope, id) }
    const etag = x.detail.schedule.etag
    if (op === 'delete') return { ok: true, change: { op: 'delete', id, base_etag: etag }, ...extra }
    const set: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'when',
      'catchup_min',
      'enabled',
      'runner',
      'permissions',
      'allowed_tools',
      'model',
      'notify',
      'prompt',
      'meta',
      'memory',
    ])
      if (a[k] !== undefined) set[k] = a[k]
    if (resultThread !== undefined) set.thread_id = resultThread
    const parsed = ScheduleChange.safeParse({ op: 'update', id, base_etag: etag, set })
    if (!parsed.success) return { ok: false, error: zodText(parsed.error) }
    return { ok: true, change: parsed.data, ...extra }
  }
  return { ok: false, error: 'op must be create, update or delete' }
}

/** R1-8: what the installed Chronos said it can do (`version.features`). Null = fine, else the words for the owner. */
export function tooOldFor(this: ScheduleService, change: ScheduleChangeT): string | null {
  const c = this.chronos()
  if (!c) return null
  const times =
    change.op === 'create'
      ? change.draft.when.type === 'times'
      : change.op === 'update' && change.set.when?.type === 'times'
  const meta =
    change.op === 'create' ? change.draft.meta !== undefined : change.op === 'update' && change.set.meta !== undefined
  if (times && !c.hasFeature('times')) return 'your Chronos is too old for several times a day; update Chronos'
  if (meta && !c.hasFeature('meta')) return 'your Chronos is too old for meta; update Chronos'
  return null
}

/** The current job as ONE `detail` call returns it: what a card must show and bind (review F4). */
export async function baseOf(
  this: ScheduleService,
  id: string,
): Promise<{ base: ScheduleCardBase; detail: ScheduleDetailT } | null> {
  const x = await this.adapter.detail(id, null)
  if (!x) return null
  return { base: { schedule: x.detail.schedule, prompt: x.detail.prompt, guard: x.detail.guard }, detail: x.detail }
}
