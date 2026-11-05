// The heartbeat check runner (HB2; docs/HEARTBEAT.md, docs/SCHEDULES.md S1.7). One call is one claimed slot:
//   quiet window -> read the store -> finish a post an earlier crash left half-done -> run the enabled sources in parallel
//   (each with its own time limit, the run with another) -> parse -> merge, dedupe by key and sig -> mutes, work gate, levels
//   -> decide wake / digest -> write the store -> post -> mark shown. No agent is woken here: `wake` is a seam, and the
//   default one hands nothing over, so act items become plain lines the owner can answer (HB4 wires the real wake).
//
// Nothing here talks to Chronos. The caller (ScheduleService) claims the slot before and closes it after.
import { existsSync } from 'node:fs'
import {
  type HeartbeatConfigT,
  HeartbeatItem,
  type HeartbeatItemT,
  HeartbeatResult,
  type HeartbeatResultT,
  type HeartbeatSourceConfigT,
  type HeartbeatSourceItemT,
  heartbeatMuteMatches,
  isQuiet,
  newId,
  newUlid,
  parseHeartbeatSourceResponse,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import type { ThreadRef } from '../notify.ts'
import { type BuiltinDeps, runBuiltin } from './builtin.ts'
import { COLD_UNKNOWN_MS, coldNote, coldness } from './cold.ts'
import { composeDigest, type DigestInput } from './digest.ts'
import { pickForPack, prunePacks, removePack } from './pack.ts'
import {
  appendShadow,
  countsOnly,
  plainError,
  type SrcOut,
  SUMMARY,
  sourceRequest,
  sum,
  type TestDetail,
  testDetail,
  updateSources,
  zero,
} from './run-parts.ts'
import { sendRow } from './send.ts'
import { baseEnv, runSource } from './spawn.ts'
import {
  addWake,
  emptyStore,
  type HeartbeatStore,
  itemId,
  loadStore,
  localDate,
  prune,
  type Running,
  type StoredItem,
  saveStore,
  storeFile,
  wakesOn,
} from './store.ts'

export { FAIL_STREAK_SAY, SHADOW_LOG } from './run-parts.ts'

/**
 * What the agent wake gets (HB4: the real one builds the run pack from `items`). The answer says what happened to the hand-over:
 *   awaiting  - the agent was sent the pack. The items stay `new` until the run reports done ok (`wakeEnded`).
 *   delivered - the hand-over is already complete (a test seam): the items are marked shown at once.
 *   neither   - nothing was sent. `retry` keeps the items for the next slot (two tries at most); without it they become lines now.
 *               `unavailable` (no triage agent) is the same, and the owner is told once to install talos-app-mod.
 */
export type HeartbeatWake = (req: {
  run_key: string
  job_id: string
  thread_id: string
  /** The run id of this slot (the claim's), which the pack and every card of this wake carry. */
  run_id: string
  /** At most MAX_PACK_ITEMS; the rest wait for the next wake and are counted here. */
  items: StoredItem[]
  left_for_next_wake: number
}) => Promise<{
  delivered: boolean
  awaiting?: boolean
  retry?: boolean
  unavailable?: boolean
  unknown?: boolean
  no_thread?: boolean
}>
/** HB2's wake: there is no agent path, so it never claims to have woken anyone. */
export const stubWake: HeartbeatWake = async () => ({ delivered: false })

/** A wake that has not come back after this long is treated as killed (the run timeout is under 45 minutes). */
export const WAKE_STALE_MS = 2 * 3600_000

export type RunnerDeps = {
  ctx: Pick<BridgeContext, 'paths' | 'clock' | 'config' | 'store' | 'transport' | 'log' | 'env'>
  builtin: (selfJobId: string) => BuiltinDeps
  wake?: HeartbeatWake
  /** Whether work-class items may be shown. Default off (docs/HEARTBEAT.md "The work gate"). */
  workAllowed?: () => boolean
  threadFor: (jobId: string) => ThreadRef
  /** False once the bridge has been stopped or superseded: no more writes, no more posts. */
  alive?: () => boolean
  /** Milliseconds in one configured "second". Tests shorten it so a 5 s time limit does not cost 5 s. */
  secondMs?: number
  /** Test seams: throw to model a crash at that point. */
  hooks?: { afterStoreWrite?: () => void; afterPost?: () => void }
}

export type RunInput = {
  jobId: string
  jobName: string
  /** The Chronos run key of the slot (or an ad-hoc Run now key). */
  runKey: string
  /** The config, or why it can't be read. `skipped` = sources of a kind this Talos doesn't know. */
  config: { config: HeartbeatConfigT; skipped: number } | { problem: string }
  trigger: 'clock' | 'run_now'
  /** A test run: sources run with dry:true; nothing is written, posted or woken. */
  dry?: boolean
  /**
   * The owner's "test these settings" (docs/HEARTBEAT.md "In the app"): a dry run that reads NO store (a config that is not saved
   * yet has none) and looks back `windowH` hours instead of at a cursor. `RunOutput.test` says what each source found.
   */
  test?: {
    windowH: number /** Called as each source answers, so a run that breaks later can still report them. */
    onSource?: (o: SrcOut) => void
  }
  /** How long this heartbeat may be off before it starts over (`coldAfterMs` of its schedule). Unset: the longest any job allows. */
  coldAfterMs?: number
  /** The run id of this slot (the Chronos claim's). Needed for a wake; a run without one cannot wake. */
  runId?: string
  signal?: AbortSignal
}

export type HeartbeatSeams = Pick<RunnerDeps, 'wake' | 'workAllowed' | 'secondMs' | 'hooks'> & {
  /** Test seam: whether the triage agent is available (production asks the mod's inventory). */
  triageAvailable?: () => boolean | 'unknown'
  /** Test seam: the `gh` binary the github source runs. */
  ghBin?: string
}

export type RunOutput = {
  result: HeartbeatResultT
  /** One short line for the Schedules row. */
  summary: string
  /** Counts by source and level. Never item text. */
  report: string
  status: 'ok' | 'failed'
  /** A failure line was posted for this run, so the generic "job didn't finish" notice would only say it twice. */
  said: boolean
  /** The bridge was stopped mid-run: nothing was written or posted, and the slot is not for this call to close. */
  aborted: boolean
  /** A live wake is out: the slot stays open until the agent reports done (or the run times out). */
  wakeOpen?: boolean
  /** Only for a `test` run: what each source found and what the settings would do. Item words are already escaped. */
  test?: TestDetail
}

export class HeartbeatRunner {
  private readonly active = new Set<AbortController>()
  constructor(private readonly d: RunnerDeps) {}

  /** Stops everything in flight: sources are killed by process group and the runs return `aborted`. */
  abortAll() {
    for (const a of this.active) a.abort()
  }

  private get home() {
    return this.d.ctx.paths.home
  }
  private get secondMs() {
    return this.d.secondMs ?? 1000
  }
  /** The owner's signed setting: `heartbeat` in config.work.enabled (changed only by a signed config.patch with a passkey step-up). */
  private workAllowed(): boolean {
    return this.d.workAllowed?.() ?? this.d.ctx.config.config.work.enabled.includes('heartbeat')
  }
  private alive() {
    return this.d.alive?.() ?? true
  }

  /** Runs wait for each other: they share one store file, and a second run must see what the first one kept. */
  private tail: Promise<unknown> = Promise.resolve()

  run(input: RunInput): Promise<RunOutput> {
    const next = this.tail.then(
      () => this.runOne(input),
      () => this.runOne(input),
    )
    this.tail = next.catch(() => {})
    return next
  }

  private async runOne(input: RunInput): Promise<RunOutput> {
    const ac = new AbortController()
    if (!this.alive() || input.signal?.aborted) return this.empty(input, 'failed', { aborted: true })
    this.active.add(ac)
    const onOuter = () => ac.abort()
    input.signal?.addEventListener('abort', onOuter, { once: true })
    try {
      return await this.runInner(input, ac)
    } finally {
      input.signal?.removeEventListener('abort', onOuter)
      this.active.delete(ac)
    }
  }

  private finishWith(
    input: RunInput,
    o: Omit<HeartbeatResultT, 'run_key'> & {
      aborted?: boolean
      status?: 'ok' | 'failed'
      wakeOpen?: boolean
      test?: TestDetail | undefined
    },
  ): RunOutput {
    const { aborted, status, wakeOpen, test, ...rest } = o
    const result = HeartbeatResult.parse({ run_key: input.runKey, ...rest })
    const n = result.new_by_level.fyi + result.new_by_level.act
    const report = [
      `${result.outcome}: ${SUMMARY[result.outcome](n, result)}`,
      ...result.sources.map(
        (s) => `${s.id}: ${s.ok ? 'ok' : 'failed'}, ${s.ms} ms${s.unreadable ? `, ${s.unreadable} unreadable` : ''}`,
      ),
      `seen ${result.items_seen} (act ${result.seen_by_level.act}, fyi ${result.seen_by_level.fyi}, silent ${result.seen_by_level.silent}); new ${result.items_new}`,
    ].join('\n')
    return {
      result,
      summary: SUMMARY[result.outcome](n, result),
      report,
      status: status ?? (result.outcome === 'failed' ? 'failed' : 'ok'),
      aborted: aborted ?? false,
      said: false,
      ...(wakeOpen ? { wakeOpen: true } : {}),
      ...(test ? { test } : {}),
    }
  }

  private empty(input: RunInput, outcome: HeartbeatResultT['outcome'], extra: { aborted?: boolean } = {}): RunOutput {
    return this.finishWith(input, {
      outcome,
      items_seen: 0,
      items_new: 0,
      seen_by_level: zero(),
      new_by_level: zero(),
      sources: [],
      ...extra,
    })
  }

  private async runInner(input: RunInput, ac: AbortController): Promise<RunOutput> {
    const { ctx } = this.d
    const nowMs = ctx.clock.now()
    const nowIso = new Date(nowMs).toISOString()
    const dry = input.dry === true || input.test !== undefined

    if ('problem' in input.config) {
      const text = `Heartbeat "${input.jobName}" can't run: ${input.config.problem}`
      const said =
        !dry &&
        this.alive() &&
        (await this.plainPost(input, text, false, nowMs).then(
          () => true,
          () => false,
        ))
      return { ...this.empty(input, 'failed'), said }
    }
    const { config, skipped } = input.config
    const shadow = config.mode === 'shadow'
    const tz = ctx.config.config.timezone

    // The quiet window is read now, not when the slot was set: a late catch-up inside it is quiet too. Run now and a test
    // run are the owner's own request and bypass it.
    if (!dry && input.trigger === 'clock' && isQuiet(new Date(nowMs), ctx.config.config.quiet_window, tz))
      return this.empty(input, 'quiet')

    const file = storeFile(this.home, shadow, input.jobId)
    const loaded = input.test ? { store: emptyStore(), corrupt: false, unreadable: 0 } : loadStore(file, !dry)
    const store: HeartbeatStore = loaded.store
    const notes: string[] = []
    if (loaded.corrupt)
      notes.push("Heartbeat's saved state could not be read, so it started over. Some items may show again.")
    if (loaded.unreadable) ctx.log.warn('heartbeat store rows dropped', { rows: loaded.unreadable })

    // What may be shown NOW. A held item is judged against today's gate, mutes and sources, not the ones it arrived under.
    const enabled = config.sources.filter((s) => s.enabled)
    const enabledIds = new Set(enabled.map((s) => s.id))
    const workSources = new Set(enabled.filter((s) => s.class === 'work').map((s) => s.id))
    const gateOn = this.workAllowed()
    const isWork = (t: StoredItem) => t.class === 'work' || workSources.has(t.source)
    const visible = (t: StoredItem) =>
      enabledIds.has(t.source) &&
      (gateOn || !isWork(t)) &&
      !heartbeatMuteMatches(config.mutes, { source: t.source, key: t.key }, nowIso)
    // With the gate off no work title stays on disk.
    if (!gateOn) for (const [id, t] of Object.entries(store.items)) if (isWork(t)) delete store.items[id]

    if (!dry && !shadow) {
      prunePacks(this.home) // every run, not only one that writes a pack
      await this.recoverPending(store, file, nowMs, visible)
    }
    // A wake that never came back (the clock moved, the close was lost): its attempt was already counted, so it is over.
    if (!dry && !shadow && store.wake && Math.abs(nowMs - Date.parse(store.wake.at)) > WAKE_STALE_MS) {
      ctx.log.warn('heartbeat wake abandoned', { run: store.wake.run_id })
      removePack(this.home, store.wake.run_id)
      store.wake = null
    }

    // How long THIS HEARTBEAT has gone without a completed run (its own last_run, not a source's silence: a source that was down
    // while the heartbeat kept running holds its cursor and delivers normally when it recovers). Past the job's own limit
    // (cold.ts) every source starts over with no cursor, and whatever it reports on that first look is the backlog, recorded and not shown.
    const { ms: coldMs, cold } = coldness(store, nowMs, input.coldAfterMs ?? COLD_UNKNOWN_MS)

    // ---- the sources
    const runMs = config.run_timeout_s * this.secondMs
    const lim = { hit: false }
    const runTimer = setTimeout(() => {
      lim.hit = true
      ac.abort()
    }, runMs)
    const outs: SrcOut[] = []
    try {
      outs.push(
        ...(await Promise.all(
          enabled.map((s) =>
            this.runSource(s, store, dry ? null : file, nowMs, dry, input.jobId, lim, ac, cold, input.test),
          ),
        )),
      )
    } finally {
      clearTimeout(runTimer)
    }
    if (this.stopped(input, ac, lim)) return this.empty(input, 'failed', { aborted: true })

    // ---- merge, dedupe, mutes, work gate
    const unreadable = new Map<string, number>(outs.map((o) => [o.id, o.unreadable]))
    const seen = new Map<string, HeartbeatItemT>()
    const sourceClass = new Map(enabled.map((s) => [s.id, s.class]))
    for (const o of outs) {
      if (!o.ok) continue
      for (const raw of o.items) {
        // a source marked work makes every item it reports work, whatever the item says (the gate cannot be skipped by a label)
        const klass = sourceClass.get(o.id) === 'work' ? 'work' : raw.class
        const row = HeartbeatItem.safeParse({
          ...raw,
          class: klass,
          source: o.id,
          first_seen: nowIso,
          last_seen: nowIso,
          count: 1,
        })
        if (!row.success) {
          unreadable.set(o.id, (unreadable.get(o.id) ?? 0) + 1)
          continue
        }
        seen.set(itemId(o.id, row.data.key), row.data)
      }
    }
    const refusedNow: Record<string, number> = {}
    const considered: Array<[string, HeartbeatItemT]> = []
    for (const [id, it] of seen) {
      if (heartbeatMuteMatches(config.mutes, { source: it.source, key: it.key }, nowIso)) continue
      if (it.class === 'work' && !this.workAllowed()) {
        // refused: reported once per key and sig, never stored, and its words never leave the Mac
        if (store.refused[id] !== it.sig) {
          store.refused[id] = it.sig
          refusedNow[it.source] = (refusedNow[it.source] ?? 0) + 1
        }
        continue
      }
      considered.push([id, it])
    }

    const seenBy = zero()
    const newBy = zero()
    let backlog = 0
    for (const [id, it] of considered) {
      seenBy[it.level]++
      const old = store.items[id]
      if (old && old.sig === it.sig) {
        old.last_seen = nowIso
        old.count += 1
        old.title = it.title
        old.level = it.level
        continue
      }
      const skipped = it.level !== 'silent' && cold
      if (skipped) backlog++
      else newBy[it.level]++
      store.items[id] = {
        ...it,
        first_seen: old?.first_seen ?? nowIso,
        count: (old?.count ?? 0) + 1,
        state: it.level === 'silent' || skipped ? 'surfaced' : 'new',
        surfaced_at: skipped ? nowIso : null,
        attempts: 0,
      }
    }
    if (cold && outs.some((o) => o.ok)) notes.push(coldNote(coldMs, backlog))

    // ---- sources' own state
    const failures = updateSources(store, outs, nowIso)
    store.last_run = nowIso

    const failedSrc = outs.filter((o) => !o.ok)
    const noSource = enabled.length === 0
    const allFailed = outs.length > 0 && failedSrc.length === outs.length
    const anyUnreadable = [...unreadable.values()].some((n) => n > 0)

    // ---- what to deliver
    const due = Object.values(store.items).filter((t) => t.state === 'new' && t.level !== 'silent' && visible(t))
    due.sort((a, b) =>
      a.level === b.level ? Date.parse(a.first_seen) - Date.parse(b.first_seen) : a.level === 'act' ? -1 : 1,
    )
    const act = due.filter((t) => t.level === 'act')
    const fyi = due.filter((t) => t.level === 'fyi')
    const date = localDate(nowMs, tz)

    const ws = await this.wakeStep({ input, config, store, file, act, shadow, dry, date, nowIso, notes })
    if (ws.saveError) return this.failedSave(input, ws.saveError, countsOnly(considered, outs))
    const { woke, wakeOpen, capped, rolled, needYou } = ws
    if (this.stopped(input, ac, lim)) return this.empty(input, 'failed', { aborted: true })

    const failedRun = noSource
      ? 'Heartbeat checked nothing: no source is turned on.'
      : allFailed
        ? `Heartbeat check failed: ${failedSrc.map((o) => `${o.id} (${o.error ?? 'no details'})`).join('; ')}`
        : null
    const digest = shadow
      ? composeDigest({ fyi: [...fyi, ...act], needYou: [], refused: refusedNow, failures, failedRun, notes })
      : composeDigest({ fyi: [...fyi, ...rolled], needYou, refused: refusedNow, failures, failedRun, notes })
    const listed = !dry && digest ? digest.listed : []

    // ---- outcome. A failure is never "silent": failed and partial outrank every quiet word.
    let outcome: HeartbeatResultT['outcome']
    if (noSource || allFailed) outcome = 'failed'
    else if (failedSrc.length || anyUnreadable || skipped > 0) outcome = 'partial'
    else if (capped) outcome = 'capped'
    else if (woke) outcome = 'woke'
    else if (digest) outcome = 'fyi'
    else outcome = 'silent'

    const sources = outs.map((o) => ({
      id: o.id,
      ok: o.ok,
      ms: Math.min(o.ms, 150_000),
      unreadable: unreadable.get(o.id) ?? 0,
      ...(o.error !== undefined ? { error: o.error } : {}),
    }))
    const counts = {
      items_seen: sum(seenBy),
      items_new: sum(newBy),
      seen_by_level: seenBy,
      new_by_level: newBy,
      sources,
    }

    // a test starts from an empty store, so `refusedNow` is exactly what the work gate held back
    const test = input.test ? testDetail(outs, seen, considered, refusedNow) : undefined
    if (dry) return this.finishWith(input, { outcome, ...counts, test })

    prune(store, nowMs)
    // ---- shadow: record everything, deliver nothing
    if (shadow) {
      for (const t of due) {
        t.state = 'surfaced'
        t.surfaced_at = nowIso
      }
      try {
        saveStore(file, store)
        appendShadow(this.home, {
          at: nowIso,
          run_key: input.runKey,
          job_id: input.jobId,
          outcome,
          would_post: digest?.text ?? null,
          would_wake: act.map((t) => itemId(t.source, t.key)),
          sources,
        })
      } catch (e) {
        return this.failedSave(input, e as Error, counts)
      }
      return this.finishWith(input, { outcome, ...counts })
    }

    // ---- live: store, then post, then mark shown
    const messageId = newId('m')
    const thread = this.d.threadFor(input.jobId)
    const ids = listed.map((t) => itemId(t.source, t.key))
    store.pending = digest
      ? {
          run_key: input.runKey,
          message_id: messageId,
          thread_id: thread.id,
          text: digest.text,
          silent: digest.silent,
          ids,
          attempts: 1,
          frame_id: newUlid(),
          created_at: nowIso,
        }
      : null
    try {
      saveStore(file, store)
    } catch (e) {
      return { ...this.failedSave(input, e as Error, counts), ...(wakeOpen ? { wakeOpen: true } : {}) }
    }
    this.d.hooks?.afterStoreWrite?.()

    let postError: Error | null = null
    if (store.pending) {
      try {
        await this.sendPending(store.pending, nowMs)
      } catch (e) {
        postError = e as Error
      }
    }
    this.d.hooks?.afterPost?.()
    if (store.pending) {
      if (!postError) {
        for (const id of store.pending.ids) {
          const t = store.items[id]
          if (t && t.state === 'new') {
            t.state = 'surfaced'
            t.surfaced_at = nowIso
          }
        }
      }
      store.pending = null
      try {
        saveStore(file, store)
      } catch (e) {
        ctx.log.warn('heartbeat store not saved after the post', { error: (e as Error).message })
      }
    }
    if (postError) {
      ctx.log.warn('heartbeat post failed', { error: postError.message })
      return this.finishWith(input, { outcome: 'failed', ...counts, wakeOpen })
    }
    return { ...this.finishWith(input, { outcome, ...counts, wakeOpen }), said: Boolean(digest && failedRun) }
  }

  /**
   * The wake decision for this run's `act` items (HB4): cap, the one-at-a-time rule, the record written before the send, the send,
   * and what happens to the items when nothing was sent. `notes` gets the "waiting for the next check-in" line.
   */
  private async wakeStep(a: {
    input: RunInput
    config: HeartbeatConfigT
    store: HeartbeatStore
    file: string
    act: StoredItem[]
    shadow: boolean
    dry: boolean
    date: string
    nowIso: string
    notes: string[]
  }): Promise<{
    woke: boolean
    wakeOpen: boolean
    capped: boolean
    rolled: StoredItem[]
    needYou: StoredItem[]
    saveError?: Error
  }> {
    const { ctx } = this.d
    const { input, config, store, file, act, shadow, dry, date, nowIso, notes } = a
    let woke = false
    let wakeOpen = false
    let capped = false
    const rolled: StoredItem[] = []
    const needYou: StoredItem[] = []
    // Shadow never wakes and never spends a wake: it records what live would have done. A dry run only asks the cap.
    if (act.length && !shadow) {
      const atCap = wakesOn(store, date) >= config.wake_cap_per_day
      if (dry) {
        capped = atCap
        woke = !atCap
      } else if (atCap) {
        capped = true
        rolled.push(...act)
      } else {
        // Items a wake still has out are not offered again; items that already had their two tries become lines.
        const out = new Set(store.wake?.ids ?? [])
        const eligible = act.filter((t) => !out.has(itemId(t.source, t.key)))
        const stuck = eligible.filter((t) => t.attempts >= 2)
        needYou.push(...stuck)
        const fresh = eligible.filter((t) => t.attempts < 2)
        // One wake at a time per job: while one is out, new act items wait (they stay `new`, and lead the next wake).
        const { picked, left } = pickForPack(fresh)
        if (picked.length && !store.wake) {
          const runId = input.runId ?? `r_${newUlid()}`
          // Recorded BEFORE the notification goes out: a crash after the send still knows a wake is out.
          for (const t of picked) t.attempts += 1
          store.wake = {
            run_id: runId,
            run_key: input.runKey,
            ids: picked.map((t) => itemId(t.source, t.key)),
            at: nowIso,
          }
          addWake(store, date)
          try {
            saveStore(file, store)
          } catch (e) {
            return { woke, wakeOpen, capped, rolled, needYou, saveError: e as Error }
          }
          let w: Awaited<ReturnType<HeartbeatWake>> = { delivered: false }
          try {
            w = await (this.d.wake ?? stubWake)({
              run_key: input.runKey,
              job_id: input.jobId,
              thread_id: this.d.threadFor(input.jobId).id,
              run_id: runId,
              items: picked,
              left_for_next_wake: left.length,
            })
          } catch (e) {
            ctx.log.warn('heartbeat wake failed', { error: (e as Error).message })
          }
          if (w.awaiting) {
            woke = true
            wakeOpen = true
            store.triage_said = false
            store.triage_unknown = 0
            store.thread_said = false
          } else {
            // nothing is out: take the record back (the attempt stays counted, the wake is spent only if it was sent)
            if (store.wake?.run_id === runId) {
              store.wake = null
              store.wakes_today = { date, count: Math.max(0, wakesOn(store, date) - 1) }
            }
            if (w.delivered) {
              woke = true
              addWake(store, date)
              for (const t of picked) {
                t.state = 'surfaced'
                t.surfaced_at = nowIso
              }
            } else if (w.unknown) {
              // the mod has not reported (a restart, a reload): that is not proof it is missing. Nothing was sent and nothing is
              // said; the attempt is given back and the items wait for the next slot. A few slots of this, then they become lines
              // (without the install line, which would be a guess).
              for (const t of picked) t.attempts = Math.max(0, t.attempts - 1)
              store.triage_unknown += 1
              if (store.triage_unknown >= 3) needYou.push(...picked)
            } else if (w.no_thread) {
              needYou.push(...picked)
              if (!store.thread_said) {
                store.thread_said = true
                notes.push("Heartbeat can't wake you until it has a thread of its own. Pick one in Schedules.")
              }
            } else if (w.unavailable) {
              store.triage_unknown = 0
              // no triage agent: nobody is woken and nothing waits for one. The items are lines now, and the owner is told once.
              needYou.push(...picked)
              if (!store.triage_said) {
                store.triage_said = true
                notes.push('Install talos-app-mod for heartbeat triage')
              }
            } else if (!(w.retry && picked.every((t) => t.attempts < 2))) needYou.push(...picked)
            // a wake that asks to be retried leaves its items new: the next slot offers them again (two tries at most)
          }
        }
        if (left.length)
          notes.push(
            `${left.length} more ${left.length === 1 ? 'item is' : 'items are'} waiting for the next check-in.`,
          )
      }
    }
    return { woke, wakeOpen, capped, rolled, needYou }
  }

  /** The bridge was stopped (or the caller gave up) before the run could finish: not the run's own time limit. */
  private stopped(input: RunInput, ac: AbortController, lim: { hit: boolean }): boolean {
    return Boolean(input.signal?.aborted) || (ac.signal.aborted && !lim.hit) || !this.alive()
  }

  private failedSave(input: RunInput, e: Error, counts: Omit<HeartbeatResultT, 'run_key' | 'outcome'>): RunOutput {
    this.d.ctx.log.warn('heartbeat store not saved', { error: e.message })
    return this.finishWith(input, { outcome: 'failed', ...counts })
  }

  // ---- one source

  private async runSource(
    cfg: HeartbeatSourceConfigT,
    store: HeartbeatStore,
    file: string | null,
    nowMs: number,
    dry: boolean,
    jobId: string,
    lim: { hit: boolean },
    run: AbortController,
    cold: boolean,
    test?: RunInput['test'],
  ): Promise<SrcOut> {
    const out = await this.runSourceOne(cfg, store, file, nowMs, dry, jobId, lim, run, cold, test?.windowH)
    test?.onSource?.(out)
    return out
  }

  private async runSourceOne(
    cfg: HeartbeatSourceConfigT,
    store: HeartbeatStore,
    file: string | null,
    nowMs: number,
    dry: boolean,
    jobId: string,
    lim: { hit: boolean },
    run: AbortController,
    cold: boolean,
    windowH?: number,
  ): Promise<SrcOut> {
    const { ctx } = this.d
    const req = sourceRequest(cfg, store.sources[cfg.id], nowMs, dry, cold, windowH)
    const t0 = performance.now()
    const limitMs = cfg.timeout_s * this.secondMs
    const own = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      own.abort()
    }, limitMs)
    const onRun = () => own.abort()
    run.signal.addEventListener('abort', onRun, { once: true })
    // `escaped`: the text already went through the source parse (capped and escaped once); it is kept as is.
    const fail = (error: string, escaped = false): SrcOut => ({
      id: cfg.id,
      ok: false,
      ms: Math.round(performance.now() - t0),
      unreadable: 0,
      error: escaped ? error : plainError(error),
      cursor: null,
      items: [],
    })
    try {
      let text: string
      if (cfg.kind === 'command') {
        const r = await runSource({
          argv: cfg.args.argv,
          cwd: cfg.args.cwd,
          env: baseEnv(ctx.env.userHome, cfg.args.env ?? {}),
          stdin: JSON.stringify(req),
          timeoutMs: limitMs,
          signal: own.signal,
          ...(file
            ? {
                onStart: (p) =>
                  this.markRunning(store, file, cfg.id, { ...p, at: new Date(ctx.clock.now()).toISOString() }),
                onEnd: () => this.markRunning(store, file, cfg.id, null),
              }
            : {}),
        })
        if (!r.ok) {
          if (r.reason === 'aborted' || r.reason === 'timeout')
            return fail(
              timedOut || r.reason === 'timeout'
                ? `no answer within ${cfg.timeout_s} s; it was stopped`
                : lim.hit
                  ? "the run's time limit was reached; it was stopped"
                  : 'stopped',
            )
          if (r.reason === 'too_big') return fail('the source printed more than 262144 bytes (256 KiB)')
          return fail(r.message)
        }
        if (r.code !== 0) {
          // a source that printed its own error before failing gets to say it
          const p = parseHeartbeatSourceResponse(r.stdout)
          if (!p.ok && !/^the source (did not print JSON|printed)/.test(p.error)) return fail(p.error, true)
          const tail = r.stderr.trim().split('\n').pop() ?? ''
          return fail(`it exited with code ${r.code}${tail ? `: ${tail.slice(0, 100)}` : ''}`)
        }
        text = r.stdout
      } else {
        try {
          text = await runBuiltin(cfg, req, this.d.builtin(jobId), own.signal, limitMs)
        } catch (e) {
          if (own.signal.aborted)
            return fail(
              timedOut
                ? `no answer within ${cfg.timeout_s} s; it was stopped`
                : lim.hit
                  ? "the run's time limit was reached; it was stopped"
                  : 'stopped',
            )
          return fail((e as Error).message)
        }
      }
      const p = parseHeartbeatSourceResponse(text)
      const ms = Math.round(performance.now() - t0)
      if (!p.ok) return { ...fail(p.error, true), ms }
      return { id: cfg.id, ok: true, ms, unreadable: p.unreadable, cursor: p.cursor, items: p.items }
    } finally {
      clearTimeout(timer)
      run.signal.removeEventListener('abort', onRun)
    }
  }

  /**
   * Keeps the store's `running` record of a source process: set when it starts, cleared when it ends. Written at once, so a crash
   * leaves it for the next start to find (orphans.ts). A superseded bridge writes nothing: the store is the next one's.
   */
  private markRunning(store: HeartbeatStore, file: string, id: string, r: Running | null) {
    if (r) store.running[id] = r
    else delete store.running[id]
    if (!this.alive()) return
    try {
      saveStore(file, store)
    } catch (e) {
      this.d.ctx.log.warn('heartbeat store not saved', { error: (e as Error).message })
    }
  }

  // ---- posting

  /** A row with no store behind it (an unreadable config). Never throws. */
  private async plainPost(input: RunInput, text: string, silent: boolean, nowMs: number): Promise<void> {
    const thread = this.d.threadFor(input.jobId)
    await this.send({ message_id: newId('m'), frame_id: newUlid(), thread_id: thread.id, text, silent }, nowMs)
  }

  private async sendPending(p: NonNullable<HeartbeatStore['pending']>, nowMs: number) {
    await this.send(
      { message_id: p.message_id, frame_id: p.frame_id, thread_id: p.thread_id, text: p.text, silent: p.silent },
      nowMs,
    )
  }

  /** One row, idempotent on its message id (send.ts). Throws when the frame cannot be accepted. */
  private send(p: Parameters<typeof sendRow>[1], nowMs: number) {
    return sendRow(this.d.ctx, p, nowMs)
  }

  /**
   * A crash between the store write and the post leaves `pending`. The post is retried ONCE: if its history row already exists
   * the post is taken as made and nothing is sent; otherwise it is sent now. Either way its items are then marked shown. The row
   * is made just before its frame goes to the outbox, so a crash in the few statements between the two leaves a row with no
   * frame, and that digest is not sent (known gap). A second leftover (a crash during the retry) is dropped and its items go out
   * in the next digest.
   */
  private async recoverPending(
    store: HeartbeatStore,
    file: string,
    nowMs: number,
    visible: (t: StoredItem) => boolean,
  ) {
    const p = store.pending
    if (!p) return
    const nowIso = new Date(nowMs).toISOString()
    let delivered = Boolean(this.d.ctx.store.getMessage(p.message_id))
    // Its text was written under an earlier gate, mutes and sources. If anything it lists may not be shown now, it is not sent.
    const stale = p.ids.some((id) => {
      const t = store.items[id]
      return !t || !visible(t)
    })
    if (!delivered && !stale && p.attempts < 2) {
      p.attempts += 1
      try {
        saveStore(file, store) // the retry is recorded before it is made: a crash inside it is not retried again
        await this.sendPending(p, nowMs)
        delivered = true
      } catch (e) {
        this.d.ctx.log.warn('heartbeat post retry failed', { error: (e as Error).message })
      }
    }
    if (delivered)
      for (const id of p.ids) {
        const t = store.items[id]
        if (t && t.state === 'new') {
          t.state = 'surfaced'
          t.surfaced_at = nowIso
        }
      }
    store.pending = null
    try {
      saveStore(file, store)
    } catch (e) {
      this.d.ctx.log.warn('heartbeat store not saved', { error: (e as Error).message })
    }
  }

  /**
   * The agent's wake came back (`ok`, or `failed` when it reported ok:false) or never will (`killed`: the run timed out, the
   * session restarted, the close was refused). Only `ok` marks the items shown. Otherwise they stay `new` and the attempt
   * already counted stands; items that have now had two tries are posted as plain lines, so nothing loops and nothing is lost.
   * Matches the open wake by run id in the saved store, so it works after a restart and ignores any other run.
   */
  wakeEnded(jobId: string, runId: string, how: 'ok' | 'failed' | 'killed'): Promise<{ matched: boolean }> {
    const next = this.tail.then(
      () => this.endWake(jobId, runId, how),
      () => this.endWake(jobId, runId, how),
    )
    this.tail = next.catch(() => {})
    return next
  }

  private async endWake(jobId: string, runId: string, how: 'ok' | 'failed' | 'killed'): Promise<{ matched: boolean }> {
    const { ctx } = this.d
    if (!this.alive()) return { matched: false }
    removePack(this.home, runId) // a wake that has ended leaves nothing for the agent to read
    const file = storeFile(this.home, false, jobId)
    if (!existsSync(file)) return { matched: false }
    const loaded = loadStore(file, false)
    const store = loaded.store
    const w = store.wake
    if (loaded.corrupt || !w || w.run_id !== runId) return { matched: false }
    const nowMs = ctx.clock.now()
    const nowIso = new Date(nowMs).toISOString()
    store.wake = null
    const items = w.ids
      .map((id) => store.items[id])
      .filter((t): t is StoredItem => t !== undefined && t.state === 'new')
    if (how === 'ok') {
      for (const t of items) {
        t.state = 'surfaced'
        t.surfaced_at = nowIso
      }
      saveStore(file, store)
      return { matched: true }
    }
    const give = items.filter((t) => t.attempts >= 2)
    const digest = give.length
      ? composeDigest({ fyi: [], needYou: give, refused: {}, failures: [], failedRun: null, notes: [] })
      : null
    if (!digest) {
      saveStore(file, store)
      return { matched: true }
    }
    const thread = this.d.threadFor(jobId)
    store.pending = {
      run_key: w.run_key,
      message_id: newId('m'),
      thread_id: thread.id,
      text: digest.text,
      silent: false,
      ids: digest.listed.map((t) => itemId(t.source, t.key)),
      attempts: 1,
      frame_id: newUlid(),
      created_at: nowIso,
    }
    saveStore(file, store)
    let posted = false
    try {
      await this.sendPending(store.pending, nowMs)
      posted = true
    } catch (e) {
      ctx.log.warn('heartbeat degrade post failed', { error: (e as Error).message })
    }
    if (posted)
      for (const id of store.pending.ids) {
        const t = store.items[id]
        if (t && t.state === 'new') {
          t.state = 'surfaced'
          t.surfaced_at = nowIso
        }
      }
    // a failed post keeps `pending` in the file: the next run retries it once (recoverPending) and the items stay new
    if (posted) store.pending = null
    saveStore(file, store)
    return { matched: true }
  }

  /** One plain heartbeat row in the job's thread (drawn under the fixed "Heartbeat" label). Throws when it cannot be sent. */
  async postLine(jobId: string, text: string, silent = false): Promise<void> {
    await this.send(
      { message_id: newId('m'), frame_id: newUlid(), thread_id: this.d.threadFor(jobId).id, text, silent },
      this.d.ctx.clock.now(),
    )
  }
}
