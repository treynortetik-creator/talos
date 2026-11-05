// The heartbeat check runner (HB2; docs/HEARTBEAT.md, docs/SCHEDULES.md S1.7). One call is one claimed slot:
//   quiet window -> read the store -> finish a post an earlier crash left half-done -> run the enabled sources in parallel
//   (each with its own time limit, the run with another) -> parse -> merge, dedupe by key and sig -> mutes, work gate, levels
//   -> decide wake / digest -> write the store -> post -> mark shown. No agent is woken here: `wake` is a seam, and the
//   default one hands nothing over, so act items become plain lines the owner can answer (HB4 wires the real wake).
//
// Nothing here talks to Chronos. The caller (ScheduleService) claims the slot before and closes it after.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Frame,
  HEARTBEAT_ERROR_MAX_CHARS,
  HEARTBEAT_SOURCE_SCHEMA,
  type HeartbeatConfigT,
  HeartbeatItem,
  type HeartbeatItemT,
  HeartbeatResult,
  type HeartbeatResultT,
  type HeartbeatSourceConfigT,
  type HeartbeatSourceItemT,
  type HeartbeatSourceRequestT,
  heartbeatMuteMatches,
  isQuiet,
  type MessageT,
  newId,
  newUlid,
  parseHeartbeatSourceResponse,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { replyFrame } from '../frames-out.ts'
import { ensureDir, writeFileAtomic } from '../fsutil.ts'
import type { ThreadRef } from '../notify.ts'
import { type BuiltinDeps, runBuiltin } from './builtin.ts'
import { composeDigest, type DigestInput } from './digest.ts'
import { baseEnv, runSource } from './spawn.ts'
import {
  addWake,
  type HeartbeatStore,
  itemId,
  loadStore,
  localDate,
  prune,
  type StoredItem,
  saveStore,
  storeFile,
  wakesOn,
} from './store.ts'

/** A source not heard from for this long starts over (no cursor) instead of flooding the owner with a backlog. */
export const REBASELINE_AFTER_MS = 72 * 3600_000
/** A source failing this many checks in a row is said once, in the thread. */
export const FAIL_STREAK_SAY = 3
export const SHADOW_LOG = 'heartbeat-shadow.jsonl'
const SHADOW_LOG_MAX_BYTES = 512 * 1024
const SHADOW_LOG_KEEP_LINES = 200

/** What the agent wake gets (HB4 builds the run pack from it). Delivered = the agent took it; anything else degrades to lines. */
export type HeartbeatWake = (req: {
  run_key: string
  job_id: string
  thread_id: string
  items: StoredItem[]
}) => Promise<{ delivered: boolean; retry?: boolean }>
/** HB2's wake: there is no agent path yet, so it never claims to have woken anyone. */
export const stubWake: HeartbeatWake = async () => ({ delivered: false })

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
  signal?: AbortSignal
}

export type HeartbeatSeams = Pick<RunnerDeps, 'wake' | 'workAllowed' | 'secondMs' | 'hooks'> & {
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
}

type SrcOut = {
  id: string
  ok: boolean
  ms: number
  unreadable: number
  error?: string
  cursor: Record<string, unknown> | null
  items: HeartbeatSourceItemT[]
}

const SUMMARY: Record<HeartbeatResultT['outcome'], (n: number, r: HeartbeatResultT) => string> = {
  silent: () => 'Nothing new',
  fyi: (n) => `${n} ${n === 1 ? 'update' : 'updates'} posted`,
  woke: (n) => `Checked in, ${n} ${n === 1 ? 'item' : 'items'}`,
  capped: () => 'Wake limit reached',
  quiet: () => 'Quiet hours',
  partial: (_n, r) => {
    const bad = r.sources.filter((s) => !s.ok).map((s) => s.id)
    return bad.length ? `Couldn't check ${bad.join(', ')}` : 'Some items could not be read'
  },
  failed: () => 'Check failed',
}

const zero = () => ({ silent: 0, fyi: 0, act: 0 })
const sum = (c: { silent: number; fyi: number; act: number }) => c.silent + c.fyi + c.act

/** An error string, capped and escaped by the same function that reads every source answer. */
function plainError(s: string): string {
  const r = parseHeartbeatSourceResponse(
    JSON.stringify({
      schema: HEARTBEAT_SOURCE_SCHEMA,
      status: 'error',
      error: s.slice(0, HEARTBEAT_ERROR_MAX_CHARS * 2),
    }),
  )
  return r.ok ? 'the source failed' : r.error
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
    o: Omit<HeartbeatResultT, 'run_key'> & { aborted?: boolean; status?: 'ok' | 'failed' },
  ): RunOutput {
    const { aborted, status, ...rest } = o
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
    const dry = input.dry === true

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
    const loaded = loadStore(file, !dry)
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

    if (!dry && !shadow) await this.recoverPending(store, file, nowMs, visible)

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
        ...(await Promise.all(enabled.map((s) => this.runSource(s, store, nowMs, nowIso, dry, input.jobId, lim, ac)))),
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
      newBy[it.level]++
      store.items[id] = {
        ...it,
        first_seen: old?.first_seen ?? nowIso,
        count: (old?.count ?? 0) + 1,
        state: it.level === 'silent' ? 'surfaced' : 'new',
        surfaced_at: null,
        attempts: 0,
      }
    }

    // ---- sources' own state
    const failures: DigestInput['failures'] = []
    for (const o of outs) {
      const s = store.sources[o.id] ?? { cursor: null, last_ok: null, fail_streak: 0 }
      if (o.ok) {
        s.cursor = o.cursor
        s.last_ok = nowIso
        s.fail_streak = 0
      } else {
        s.fail_streak += 1
        if (s.fail_streak === FAIL_STREAK_SAY)
          failures.push({ id: o.id, error: o.error ?? 'no details', streak: s.fail_streak })
      }
      store.sources[o.id] = s
    }

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

    let woke = false
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
        let w: { delivered: boolean; retry?: boolean } = { delivered: false }
        try {
          w = await (this.d.wake ?? stubWake)({
            run_key: input.runKey,
            job_id: input.jobId,
            thread_id: this.d.threadFor(input.jobId).id,
            items: act,
          })
        } catch (e) {
          ctx.log.warn('heartbeat wake failed', { error: (e as Error).message })
        }
        for (const t of act) t.attempts += 1
        if (w.delivered) {
          woke = true
          addWake(store, date)
          for (const t of act) {
            t.state = 'surfaced'
            t.surfaced_at = nowIso
          }
        } else if (!(w.retry && act.every((t) => t.attempts < 2))) needYou.push(...act)
        // a wake that asks to be retried leaves its items new: the next slot offers them again (two tries at most)
      }
    }
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

    if (dry) return this.finishWith(input, { outcome, ...counts })

    prune(store, nowMs)
    // ---- shadow: record everything, deliver nothing
    if (shadow) {
      for (const t of due) {
        t.state = 'surfaced'
        t.surfaced_at = nowIso
      }
      try {
        saveStore(file, store)
        this.appendShadow({
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
      return this.failedSave(input, e as Error, counts)
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
      return this.finishWith(input, { outcome: 'failed', ...counts })
    }
    return { ...this.finishWith(input, { outcome, ...counts }), said: Boolean(digest && failedRun) }
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
    nowMs: number,
    nowIso: string,
    dry: boolean,
    jobId: string,
    lim: { hit: boolean },
    run: AbortController,
  ): Promise<SrcOut> {
    const { ctx } = this.d
    const state = store.sources[cfg.id]
    const stale = state?.last_ok ? nowMs - Date.parse(state.last_ok) > REBASELINE_AFTER_MS : false
    const req: HeartbeatSourceRequestT = {
      schema: HEARTBEAT_SOURCE_SCHEMA,
      now: nowIso,
      since: state?.last_ok && !stale ? state.last_ok : null,
      cursor: stale ? null : (state?.cursor ?? null),
      dry,
    }
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

  /**
   * One row, idempotent on its message id: the history row is made first, then the frame goes through the outbox (which
   * keeps it until the relay acks, across reconnects). A message that already exists is never made or sent again. Throws
   * when the frame cannot be accepted (too big, refused).
   */
  private async send(
    p: { message_id: string; frame_id: string; thread_id: string; text: string; silent: boolean },
    nowMs: number,
  ) {
    const { ctx } = this.d
    if (ctx.store.getMessage(p.message_id)) return
    const message: MessageT = {
      id: p.message_id,
      thread_id: p.thread_id,
      author: 'system',
      kind: 'text',
      text: p.text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(nowMs).toISOString(),
      heartbeat: true,
    }
    ctx.store.addMessage(message)
    const frame = { ...replyFrame(nowMs, message, p.silent ? { silent: true } : {}), id: p.frame_id } as Frame
    await ctx.transport.sendDurable(frame)
  }

  /**
   * A crash between the store write and the post leaves `pending`. The post is retried ONCE: if its message already exists
   * (the crash came after the post began) nothing is sent; otherwise it is sent now. Either way its items are then marked
   * shown. A second leftover (a crash during the retry) is dropped and its items go out in the next digest.
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

  private appendShadow(row: Record<string, unknown>) {
    const path = join(this.home, SHADOW_LOG)
    ensureDir(this.home)
    appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    try {
      if (existsSync(path) && statSync(path).size > SHADOW_LOG_MAX_BYTES) {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
        const keep = lines.slice(-SHADOW_LOG_KEEP_LINES).join('\n')
        writeFileAtomic(path, `${keep}\n`, 0o600)
      }
    } catch {
      // trimming is housekeeping; the row above is already written
    }
  }
}
