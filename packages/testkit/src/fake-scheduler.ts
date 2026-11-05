// FakeScheduler: an in-memory SchedulerAdapter that passes the same contract as the real Chronos adapter
// (defineSchedulerAdapterContract). It emulates Chronos 0.3: the (id, ds) state machine of docs/SCHEDULES.md S7.5,
// claims and markers keyed on ds, the approved record and holds (N1, B1), the one writer (validate then apply with
// base_etag), and RFC 3339 times with offsets in an IANA zone. Hashes are real sha256 but over the fake's own record,
// so they are opaque, exactly like Chronos's.
import {
  ChronosChange,
  type ChronosChangeT,
  type ChronosDraftT,
  type ChronosSnapshotT,
  type ClaimResult,
  type DayStateT,
  DETAIL_PROMPT_MAX_BYTES,
  type DueForSession,
  deriveWaitReason,
  type HealthIssueT,
  jcs,
  MAX_SCHEDULES_PER_SNAPSHOT,
  newUlid,
  PROMPT_MAX_BYTES,
  REPORT_MAX_BYTES,
  type ScheduleDetailT,
  type ScheduleLastRunT,
  type SchedulePreviewT,
  type ScheduleRunT,
  type SchedulerAdapter,
  type SchedulerHealthT,
  type ScheduleSnapshotT,
  type ScheduleT,
  type ScheduleWhenT,
  type SessionPromptResult,
  sha256Hex,
  type ValidateResult,
} from '@talos-app/protocol'
import {
  addDays,
  dayOfMonth,
  isoInZone,
  isRealDate,
  localDate,
  localToInstant,
  weekdayOf,
  whenWords,
} from './sched-time.ts'

/** The fake models Chronos 0.3's one-fire-time jobs only: `times` and `meta` are refused loudly (see validate), never half-modelled. */
type FakeWhen = Exclude<ScheduleWhenT, { type: 'times' }>
type Rec = {
  id: string
  name: string
  description: string
  kind: 'claude'
  when: FakeWhen
  catchup_min: number
  enabled: boolean
  runner: 'session' | 'headless' | 'both'
  permissions: 'full' | 'restricted'
  allowed_tools: string[]
  model: string | null
  notify: 'failure' | 'always' | 'never'
}
type Job = { rec: Rec; prompt: string; guard: string | null; threadId: string | null }
type Claim = {
  runId: string
  ds: string
  runner: 'session' | 'headless'
  bridgeInstance: string
  trigger: 'clock' | 'run_now'
  claimedMs: number
}
type Run = { run: ScheduleRunT; report: string; closed: boolean; startedMs: number }
type Approved = { contentHash: string; prompt: string; guard: string | null; approvedAt: string; via: string }

export type FakeSchedulerOptions = {
  tz?: string
  /** RFC 3339 or epoch ms. Default: the real clock at construction. */
  now?: string | number
  sessionRunner?: 'talos' | 'hook'
  approvalRequired?: boolean
  hostLabel?: string
}

const utf8 = (s: string) => new TextEncoder().encode(s).length
const h = (s: string) => `sha256:${sha256Hex(s)}`
const key = (id: string, ds: string) => `${id}|${ds}`
const DRAFT_KEYS = [
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
] as const
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

function cutBytes(s: string, max: number): string {
  if (utf8(s) <= max) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const b = utf8(ch)
    if (n + b > max) break
    out += ch
    n += b
  }
  return out
}

export class FakeScheduler implements SchedulerAdapter {
  readonly id = 'fake'
  tz: string
  sessionRunner: 'talos' | 'hook'
  approvalRequired: boolean
  hostLabel: string
  pausedAll = false
  headlessBlocked = false
  /** Every adapter call, in order (for single-flight and queue tests). */
  readonly calls: string[] = []
  private nowMs: number
  private beatMs: number | null = null
  private jobs = new Map<string, Job>()
  private approvedRecs = new Map<string, Approved>()
  private pausedJobs = new Set<string>()
  private markers = new Map<string, 'ran' | 'failed' | 'stalled'>()
  private claims = new Map<string, Claim>()
  private runs = new Map<string, Run[]>()
  private offers = new Map<string, number>()

  constructor(opts: FakeSchedulerOptions = {}) {
    this.tz = opts.tz ?? 'UTC'
    this.nowMs = opts.now === undefined ? Date.now() : typeof opts.now === 'number' ? opts.now : Date.parse(opts.now)
    this.sessionRunner = opts.sessionRunner ?? 'talos'
    this.approvalRequired = opts.approvalRequired ?? true
    this.hostLabel = opts.hostLabel ?? 'Example Mac'
  }

  /** A fake holding the jobs of a real `chronos api snapshot` golden (prompt = its preview), at its `as_of`. */
  static fromChronosSnapshot(snap: ChronosSnapshotT, opts: { hostLabel?: string } = {}): FakeScheduler {
    const s = new FakeScheduler({
      tz: snap.tz,
      now: snap.as_of,
      sessionRunner: snap.session_runner,
      approvalRequired: snap.approval_required,
      ...opts,
    })
    s.pausedAll = snap.paused_all
    for (const j of snap.schedules) {
      if ('error' in j || j.kind !== 'claude' || j.permissions === 'command') continue
      if (j.when.type === 'times' || j.meta !== undefined)
        throw new Error(
          `the fake scheduler cannot load ${j.id}: it has times or meta (replay the Chronos 0.4 fixtures instead)`,
        )
      const job: Job = {
        rec: {
          id: j.id,
          name: j.name,
          description: j.description,
          kind: 'claude',
          when: j.when,
          catchup_min: j.catchup_min,
          enabled: j.enabled,
          runner: j.runner,
          permissions: j.permissions,
          allowed_tools: [...j.allowed_tools],
          model: j.model,
          notify: j.notify,
        },
        prompt: j.prompt_preview,
        guard: null,
        threadId: null,
      }
      s.jobs.set(j.id, job)
      if (j.paused) s.pausedJobs.add(j.id)
      if (!j.changed_outside) s.writeApproved(job, 'migrate')
    }
    return s
  }

  // ---- test controls -----------------------------------------------------------------------------------------------

  setNow(iso: string | number) {
    this.nowMs = typeof iso === 'number' ? iso : Date.parse(iso)
  }
  get now(): number {
    return this.nowMs
  }
  /** A local process rewriting prompt.md: no apply, no approval. */
  editPromptOutside(id: string, prompt: string) {
    const j = this.mustJob(id)
    j.prompt = prompt
  }
  /** The bridge sidecar's offer for (id, ds), so `wait_reason` can say `offered` (N6). */
  markOffered(id: string, ds: string, atMs = this.nowMs) {
    this.offers.set(key(id, ds), atMs)
  }
  /** The Talos-only result thread (sidecar). */
  setThread(id: string, threadId: string | null) {
    this.mustJob(id).threadId = threadId
  }
  blockHeadless() {
    this.headlessBlocked = true
  }
  /** Creates a job through the real seam (validate + apply), optionally with its result thread. */
  async seed(draft: ChronosDraftT & { thread_id?: string | null }): Promise<string> {
    const { thread_id, ...d } = draft
    const v = await this.validate({ op: 'create', draft: d })
    if (!v.ok) throw new Error(`seed refused: ${JSON.stringify(v.errors)}`)
    const r = await this.apply(v.normalized, v.expectedEtag)
    if (!r.ok) throw new Error(`seed refused: ${r.message}`)
    if (thread_id !== undefined) this.setThread(d.id, thread_id)
    return r.etag as string
  }

  // ---- derived state -------------------------------------------------------------------------------------------------

  private iso(ms = this.nowMs) {
    return isoInZone(ms, this.tz)
  }
  private today() {
    return localDate(this.nowMs, this.tz)
  }
  private mustJob(id: string): Job {
    const j = this.jobs.get(id)
    if (!j) throw new Error(`no job ${id}`)
    return j
  }
  private etagOf(rec: Rec, prompt: string, guard: string | null) {
    return h(`${jcs(rec)}\u0000${prompt}\u0000${guard ?? ''}`)
  }
  private contentHashOf(rec: Rec, prompt: string, guard: string | null) {
    const { kind, permissions, allowed_tools, model, runner } = rec
    return h(`${jcs({ kind, permissions, allowed_tools, model, runner })}\u0000${prompt}\u0000${guard ?? ''}`)
  }
  private changedOutside(j: Job) {
    const a = this.approvedRecs.get(j.rec.id)
    return !a || a.contentHash !== this.contentHashOf(j.rec, j.prompt, j.guard)
  }
  private held(j: Job) {
    return this.approvalRequired && this.changedOutside(j)
  }
  private writeApproved(j: Job, via: string) {
    this.approvedRecs.set(j.rec.id, {
      contentHash: this.contentHashOf(j.rec, j.prompt, j.guard),
      prompt: j.prompt,
      guard: j.guard,
      approvedAt: this.iso(),
      via,
    })
  }
  private scheduledOn(rec: Rec, ds: string): boolean {
    const w = rec.when
    switch (w.type) {
      case 'daily':
        return true
      case 'weekdays':
        return !['sat', 'sun'].includes(weekdayOf(ds))
      case 'days':
        return (w.days as string[]).includes(weekdayOf(ds))
      case 'monthdays':
        return isRealDate(ds) && w.days.includes(dayOfMonth(ds))
      case 'once':
        return w.at.slice(0, 10) === ds
      case 'events':
        return false
    }
  }
  private fireMs(rec: Rec, ds: string): number {
    const w = rec.when
    if (w.type === 'once') return localToInstant(w.at.slice(0, 10), w.at.slice(11, 16), this.tz)
    if (w.type === 'events') return Number.POSITIVE_INFINITY
    return localToInstant(ds, w.time, this.tz)
  }
  private nextFires(rec: Rec, n: number, ignoreEnabled = false): string[] {
    if ((!rec.enabled && !ignoreEnabled) || rec.when.type === 'events') return []
    const out: string[] = []
    let ds = this.today()
    for (let i = 0; i < 400 && out.length < n; i++, ds = addDays(ds, 1)) {
      if (!this.scheduledOn(rec, ds)) continue
      const f = this.fireMs(rec, ds)
      if (f > this.nowMs) out.push(this.iso(f))
    }
    return out
  }
  /** The ds the job's current row is about: yesterday while yesterday's run is open or still inside its window. */
  private currentDs(j: Job): string {
    const today = this.today()
    const y = addDays(today, -1)
    const k = key(j.rec.id, y)
    if (this.claims.has(k)) return y
    if (j.rec.enabled && this.scheduledOn(j.rec, y) && !this.markers.has(k)) {
      const f = this.fireMs(j.rec, y)
      if (f <= this.nowMs && this.nowMs < f + j.rec.catchup_min * 60_000) return y
    }
    return today
  }
  private dayState(j: Job, ds: string): DayStateT {
    const r = j.rec
    if (!r.enabled || !this.scheduledOn(r, ds)) return 'not_due'
    if (this.held(j)) return 'held'
    const k = key(r.id, ds)
    if (this.claims.has(k)) return 'running'
    const m = this.markers.get(k)
    if (m) return m
    const f = this.fireMs(r, ds)
    if (this.nowMs < f) return 'pending'
    if (this.nowMs < f + r.catchup_min * 60_000) return 'waiting'
    return 'missed'
  }
  private beatAgeS(): number | null {
    return this.beatMs === null ? null : Math.max(0, Math.floor((this.nowMs - this.beatMs) / 1000))
  }
  private schedule(j: Job): ScheduleT {
    const r = j.rec
    const ds = this.currentDs(j)
    const today = this.dayState(j, ds)
    const offer = this.offers.get(key(r.id, ds))
    const wait = deriveWaitReason(
      today,
      this.beatAgeS(),
      offer === undefined ? null : Math.floor((this.nowMs - offer) / 1000),
    )
    const last = this.lastRun(r.id)
    const claim = this.claims.get(key(r.id, ds))
    const paused = this.pausedJobs.has(r.id)
    const held = this.held(j)
    const tooLong = utf8(j.prompt) > PROMPT_MAX_BYTES
    const readOnly =
      r.runner === 'both'
        ? 'Session, with a background backup (set outside Talos)'
        : tooLong
          ? 'Prompt is longer than the app can edit. Edit it at the Mac'
          : null
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      when: r.when,
      when_text: whenWords(r.when),
      catchup_min: r.catchup_min,
      enabled: r.enabled,
      paused,
      runner: r.runner,
      permissions: r.permissions,
      allowed_tools: [...r.allowed_tools],
      model: r.model,
      notify: r.notify,
      thread_id: j.threadId,
      triggers_count: 0,
      next_run: this.nextFires(r, 1)[0] ?? null,
      today,
      wait_reason: wait,
      window_ends:
        today === 'waiting' || today === 'running' ? this.iso(this.fireMs(r, ds) + r.catchup_min * 60_000) : null,
      last_run: last,
      prompt_preview: j.prompt.replace(CONTROL, '').slice(0, 400),
      prompt_bytes: utf8(j.prompt),
      editable: readOnly === null,
      read_only_reason: readOnly,
      changed_outside: this.changedOutside(j),
      etag: this.etagOf(r, j.prompt, j.guard),
      content_hash: this.contentHashOf(r, j.prompt, j.guard),
      state_rev: h(
        jcs({
          ds,
          today,
          claim: claim?.runId ?? null,
          last: last?.run_id ?? last?.ds ?? null,
          last_status: last?.status ?? null,
          paused,
          paused_all: this.pausedAll,
          held,
          beat_fresh: (this.beatAgeS() ?? 9999) <= 180,
          wait,
        }),
      ),
    }
  }

  // ---- SchedulerAdapter ----------------------------------------------------------------------------------------------

  async detect() {
    this.calls.push('detect')
    return { installed: true, supported: true, version: '0.3.0-fake', api: 1, sessionRunner: this.sessionRunner }
  }

  async snapshot(): Promise<ScheduleSnapshotT> {
    this.calls.push('snapshot')
    const all = [...this.jobs.values()].map((j) => this.schedule(j))
    const health = this.healthNow(all)
    return {
      protocol: 1,
      health,
      schedules: all.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
      unreadable: [],
      as_of: this.iso(),
    }
  }

  async detail(id: string, reportRunId: string | null) {
    this.calls.push('detail')
    const j = this.jobs.get(id)
    if (!j) return null
    // Chronos v0.3.0 answers `runs: []` from `detail`; the fake does the same so S3 doesn't build on
    // a list the real scheduler doesn't send yet.
    const runs: Run[] = []
    const prompt = cutBytes(j.prompt, DETAIL_PROMPT_MAX_BYTES)
    const detail: ScheduleDetailT = {
      schedule: this.schedule(j),
      prompt,
      prompt_truncated: prompt.length !== j.prompt.length,
      guard: j.guard,
      next_runs: this.nextFires(j.rec, 3),
      runs: runs.map((r) => ({ ...r.run })),
    }
    const hit = reportRunId ? (this.runs.get(id) ?? []).find((r) => r.run.run_id === reportRunId) : undefined
    const report = hit?.report ? cutBytes(hit.report.replace(CONTROL, ''), REPORT_MAX_BYTES) : null
    return { detail, report }
  }

  private merged(change: ChronosChangeT): { rec: Rec; prompt: string; guard: string | null } | null {
    if (change.op === 'create') {
      const { prompt, id, meta: _meta, ...d } = change.draft // validate() has refused times and meta already
      return {
        rec: { id, kind: 'claude', ...d, when: d.when as FakeWhen, allowed_tools: [...d.allowed_tools] },
        prompt,
        guard: null,
      }
    }
    const j = this.jobs.get(change.id)
    if (!j) return null
    if (change.op !== 'update') return { rec: j.rec, prompt: j.prompt, guard: j.guard }
    const rec: Rec = { ...j.rec }
    const r = rec as Record<string, unknown>
    for (const k of DRAFT_KEYS) if (change.set[k] !== undefined) r[k] = change.set[k]
    return { rec, prompt: change.set.prompt ?? j.prompt, guard: j.guard }
  }

  private preview(rec: Rec): SchedulePreviewT {
    return { when_text: whenWords(rec.when), next_runs: this.nextFires(rec, 3, true), tz: this.tz }
  }

  /** Mirrors Chronos `plan_change` (chronos_write.py): the same checks, in the same order, for validate and apply. */
  async validate(change: ChronosChangeT): Promise<ValidateResult> {
    this.calls.push('validate')
    const parsed = ChronosChange.safeParse(change)
    if (!parsed.success)
      return {
        ok: false,
        code: 'schedule_invalid',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }
    const c = structuredClone(parsed.data)
    const no = (code: Exclude<ValidateResult, { ok: true }>['code'], path: string, message: string) => ({
      ok: false as const,
      code,
      errors: [{ path, message }],
    })
    const restrictedSession = 'a restricted job cannot also run in a live session'
    const unmodelled = (w: { type: string } | undefined, meta: unknown, at: string) =>
      w?.type === 'times' || meta !== undefined
        ? no(
            'schedule_invalid',
            at,
            'the fake scheduler models one fire time a day and no meta; use the Chronos 0.4 fixtures for times',
          )
        : null
    if (c.op === 'create') {
      const refused = unmodelled(c.draft.when, c.draft.meta, 'draft')
      if (refused) return refused
      if (this.jobs.has(c.draft.id)) return no('schedule_conflict', 'draft.id', 'already exists')
      if (c.draft.permissions === 'restricted' && c.draft.runner !== 'headless')
        return no('schedule_invalid', 'permissions', restrictedSession)
    } else {
      const j = this.jobs.get(c.id)
      if (!j) return no('schedule_not_found', 'id', 'no such job')
      if (c.op === 'adopt') {
        if (c.content_hash !== this.contentHashOf(j.rec, j.prompt, j.guard))
          return no('schedule_conflict', 'content_hash', 'stale')
      } else {
        if (c.base_etag !== this.etagOf(j.rec, j.prompt, j.guard)) return no('schedule_conflict', 'base_etag', 'stale')
        if (c.op === 'update') {
          const refused = unmodelled(c.set.when, c.set.meta, 'set')
          if (refused) return refused
          if (this.held(j)) return no('held', 'id', 'held')
          if (Object.keys(c.set).length === 0)
            return no('schedule_invalid', 'set', 'update needs at least one field in set')
          if (j.rec.when.type === 'events')
            return no('schedule_invalid', 'id', 'command jobs and event-only jobs are edited at the Mac')
          if (j.rec.runner === 'both' && c.set.runner === undefined)
            return no('schedule_invalid', 'runner', 'choose session or headless for this job')
          const perms = c.set.permissions ?? j.rec.permissions
          const runner = c.set.runner ?? j.rec.runner
          if (perms === 'restricted' && runner !== 'headless')
            return no('schedule_invalid', 'permissions', restrictedSession)
        }
      }
    }
    const m = this.merged(c)
    if (!m) return no('schedule_not_found', 'id', 'no such job')
    return {
      ok: true,
      normalized: c,
      preview: this.preview(m.rec),
      expectedEtag: c.op === 'delete' ? null : this.etagOf(m.rec, m.prompt, m.guard),
    }
  }

  async apply(change: ChronosChangeT, expectedEtag: string | null) {
    this.calls.push('apply')
    const v = await this.validate(change)
    if (!v.ok)
      return { ok: false as const, code: v.code, message: v.errors.map((e) => `${e.path}: ${e.message}`).join('; ') }
    if (jcs(v.normalized) !== jcs(change))
      return { ok: false as const, code: 'schedule_invalid' as const, message: 'the change is not normalized' }
    if (expectedEtag !== v.expectedEtag)
      return {
        ok: false as const,
        code: 'schedule_conflict' as const,
        message: 'the result would not have the expected etag',
      }
    const c = v.normalized
    if (c.op === 'create') {
      const m = this.merged(c) as NonNullable<ReturnType<FakeScheduler['merged']>>
      const job: Job = { rec: m.rec, prompt: m.prompt, guard: null, threadId: null }
      this.jobs.set(c.draft.id, job)
      this.writeApproved(job, 'api_apply')
      return { ok: true as const, etag: this.etagOf(job.rec, job.prompt, job.guard) }
    }
    const j = this.mustJob(c.id)
    if (c.op === 'update') {
      const m = this.merged(c) as NonNullable<ReturnType<FakeScheduler['merged']>>
      j.rec = m.rec
      j.prompt = m.prompt
      this.writeApproved(j, 'api_apply')
      return { ok: true as const, etag: this.etagOf(j.rec, j.prompt, j.guard) }
    }
    if (c.op === 'delete') {
      this.jobs.delete(c.id)
      this.approvedRecs.delete(c.id)
      this.pausedJobs.delete(c.id)
      return { ok: true as const, etag: null }
    }
    this.writeApproved(j, 'adopt')
    return { ok: true as const, etag: this.etagOf(j.rec, j.prompt, j.guard) }
  }

  async setPaused(scope: { id: string } | 'all', paused: boolean) {
    this.calls.push('setPaused')
    if (scope === 'all') this.pausedAll = paused
    else {
      this.mustJob(scope.id)
      if (paused) this.pausedJobs.add(scope.id)
      else this.pausedJobs.delete(scope.id)
    }
  }

  async disable(id: string) {
    this.calls.push('disable')
    const j = this.mustJob(id)
    j.rec = { ...j.rec, enabled: false }
    return { etag: this.etagOf(j.rec, j.prompt, j.guard) }
  }

  async approved(id: string) {
    this.calls.push('approved')
    const a = this.approvedRecs.get(id)
    return a ? { contentHash: a.contentHash, prompt: a.prompt, guard: a.guard, approvedAt: a.approvedAt } : null
  }

  async dueForSession(): Promise<DueForSession[]> {
    this.calls.push('dueForSession')
    this.beatMs = this.nowMs
    if (this.pausedAll) return []
    const today = this.today()
    const out: DueForSession[] = []
    for (const j of this.jobs.values()) {
      const r = j.rec
      if (r.runner === 'headless' || !r.enabled || r.permissions === 'restricted' || r.when.type === 'events') continue
      if (this.pausedJobs.has(r.id) || this.held(j)) continue
      for (const ds of [addDays(today, -1), today]) {
        const k = key(r.id, ds)
        if (!this.scheduledOn(r, ds) || this.claims.has(k) || this.markers.has(k)) continue
        const f = this.fireMs(r, ds)
        const end = f + r.catchup_min * 60_000
        if (f <= this.nowMs && this.nowMs < end)
          out.push({ id: r.id, ds, fire_at: this.iso(f), window_ends: this.iso(end) })
      }
    }
    return out.sort((a, b) => Date.parse(a.fire_at) - Date.parse(b.fire_at) || a.id.localeCompare(b.id))
  }

  /** Like Chronos `_last_run`: the latest day with a ran-/failed-/stalled- marker, with its run's fields when known. */
  private lastRun(id: string): ScheduleLastRunT | null {
    let best: { ds: string; status: 'ok' | 'failed' | 'launch_stalled' } | null = null
    for (const [k, m] of this.markers) {
      const [jid, ds] = k.split('|') as [string, string]
      if (jid !== id) continue
      if (!best || ds >= best.ds)
        best = { ds, status: m === 'ran' ? 'ok' : m === 'failed' ? 'failed' : 'launch_stalled' }
    }
    if (!best) return null
    const row = [...(this.runs.get(id) ?? [])].reverse().find((r) => r.closed && r.run.ds === best.ds)
    if (row) return { ...row.run }
    return { ds: best.ds, status: best.status, has_report: false }
  }

  private dateKey(j: Job): string {
    return j.rec.when.type === 'once' ? j.rec.when.at.slice(0, 10) : this.today()
  }

  /** Mirrors Chronos `claim_run` (chronos_runlog.py), check for check and in the same order. */
  async claim(
    id: string,
    a: {
      runId: string
      ds: string | null
      fireAt: string | null
      manual: boolean
      again: boolean
      bridgeInstance: string
    },
  ): Promise<ClaimResult> {
    this.calls.push('claim')
    const j = this.jobs.get(id)
    if (!j) return { ok: false, reason: 'schedule_not_found' }
    if (j.rec.permissions === 'restricted') return { ok: false, reason: 'schedule_invalid' } // session claim
    const ds = a.ds ?? this.dateKey(j)
    if (this.held(j)) return { ok: false, reason: 'held' }
    if (!a.manual) {
      if (!j.rec.enabled || j.rec.when.type === 'events' || !this.scheduledOn(j.rec, ds))
        return { ok: false, reason: 'not_due' }
      const f = this.fireMs(j.rec, ds)
      if (this.nowMs < f) return { ok: false, reason: 'not_due' }
      if (this.nowMs >= f + j.rec.catchup_min * 60_000) return { ok: false, reason: 'window_passed' }
      if (this.pausedAll || this.pausedJobs.has(id)) return { ok: false, reason: 'paused' }
    }
    const k = key(id, ds)
    const m = this.markers.get(k)
    if (m === 'ran' && !(a.manual && a.again)) return { ok: false, reason: 'already_done' }
    if (!a.manual && m) return { ok: false, reason: 'failed_today' }
    if (this.claims.has(k)) return { ok: false, reason: 'running_elsewhere' }
    if (a.manual) this.markers.delete(k) // under the claim: Run now clears failed-/stalled-, and with again ran- (S7.5)
    this.claims.set(k, {
      runId: a.runId,
      ds,
      runner: 'session',
      bridgeInstance: a.bridgeInstance,
      trigger: a.manual ? 'run_now' : 'clock',
      claimedMs: this.nowMs,
    })
    return { ok: true, runId: a.runId, ds }
  }

  private closeRun(id: string, run: ScheduleRunT, report: string, startedMs: number) {
    const list = this.runs.get(id) ?? []
    list.push({ run, report, closed: true, startedMs })
    this.runs.set(id, list)
  }

  /** Mirrors Chronos `finish_run`: a closed run is `late` (its words kept as a note), else the owner check, then status. */
  async finish(
    id: string,
    a: { runId: string; status: 'ok' | 'failed' | 'timed_out' | 'session_ended'; report: string; ok?: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: 'not_owner' | 'late' }> {
    this.calls.push('finish')
    const closed = (this.runs.get(id) ?? []).find((r) => r.run.run_id === a.runId && r.closed)
    if (closed) {
      if (a.report) closed.run.late_note = a.report.trim().slice(0, 280)
      return { ok: false, reason: 'late' }
    }
    const entry = [...this.claims.entries()].find(
      ([k, c]) => k.startsWith(`${id}|`) && c.runId === a.runId && c.runner === 'session',
    )
    if (!entry) return { ok: false, reason: 'not_owner' }
    const [k, c] = entry
    const ok = a.status === 'ok'
    this.markers.set(k, ok ? 'ran' : 'failed')
    this.claims.delete(k)
    // Chronos stores no summary (the bridge keeps schedule_run_done's summary itself)
    this.closeRun(
      id,
      {
        run_id: a.runId,
        ds: c.ds,
        started_at: this.iso(c.claimedMs),
        runner: 'session',
        trigger: c.trigger,
        status: a.status,
        duration_s: Math.max(0, Math.floor((this.nowMs - c.claimedMs) / 1000)),
        has_report: a.report.length > 0,
      },
      a.report,
      c.claimedMs,
    )
    const j = this.jobs.get(id)
    if (ok && j && j.rec.when.type === 'once') j.rec = { ...j.rec, enabled: false } // disable_once; content_hash untouched
    return { ok: true }
  }

  async orphanedSessionClaims(current: string) {
    this.calls.push('orphanedSessionClaims')
    const out: Array<{ id: string; ds: string; runId: string; bridgeInstance: string }> = []
    for (const [k, c] of this.claims)
      if (c.runner === 'session' && c.bridgeInstance !== current)
        out.push({ id: k.split('|')[0] as string, ds: c.ds, runId: c.runId, bridgeInstance: c.bridgeInstance })
    return out
  }

  /** Mirrors Chronos `start_headless`. The fake's "run" finishes at once, ok. */
  async startHeadless(id: string, a: { again: boolean }) {
    this.calls.push('startHeadless')
    const refuse = <C extends string>(code: C, message: string) => ({ ok: false as const, code, message })
    const j = this.jobs.get(id)
    if (!j) return refuse('schedule_not_found', 'no such job')
    if (this.held(j)) return refuse('held', 'this job is on hold: its instructions differ from what was approved')
    if (j.rec.runner === 'session') return refuse('schedule_invalid', 'this job runs in your live session only')
    if (this.headlessBlocked)
      return refuse('headless_blocked', 'background runs are off until the launch problem is fixed')
    const ds = this.dateKey(j)
    const k = key(id, ds)
    if (this.markers.get(k) === 'ran' && !a.again)
      return refuse('schedule_invalid', `this job already ran for ${ds}; start it again with again=true`)
    if (this.claims.has(k)) return refuse('already_running', 'this job is already running')
    const runId = `r_${newUlid()}`
    this.markers.set(k, 'ran')
    this.closeRun(
      id,
      {
        run_id: runId,
        ds,
        started_at: this.iso(),
        runner: 'headless',
        trigger: 'run_now',
        status: 'ok',
        duration_s: 0,
        cost_usd: 0,
        has_report: false,
      },
      '',
      this.nowMs,
    )
    return { ok: true as const, runId, ds }
  }

  async sessionPrompt(id: string): Promise<SessionPromptResult> {
    this.calls.push('sessionPrompt')
    const j = this.jobs.get(id)
    if (!j) return { ok: false, code: 'schedule_not_found' }
    if (this.held(j)) return { ok: false, code: 'held' }
    if (j.rec.permissions === 'restricted') return { ok: false, code: 'schedule_invalid' }
    return { ok: true, guard: j.guard, prompt: j.prompt, contentHash: this.contentHashOf(j.rec, j.prompt, j.guard) }
  }

  async health(): Promise<SchedulerHealthT> {
    this.calls.push('health')
    return this.healthNow([...this.jobs.values()].map((j) => this.schedule(j)))
  }

  private healthNow(all: ScheduleT[]): SchedulerHealthT {
    const since = this.iso()
    const issues: HealthIssueT[] = []
    const add = (code: HealthIssueT['code'], severity: HealthIssueT['severity'], text: string, fix: string | null) =>
      issues.push({ code, severity, text, fix, schedule_id: null, since })
    if (this.sessionRunner !== 'talos' || !this.approvalRequired)
      add(
        'session_runner_conflict',
        'error',
        "Chronos's own session timers are still on, so Talos won't run jobs (to avoid running them twice).",
        'At the Mac run `talos-app schedules adopt`, then restart your session.',
      )
    if (this.pausedAll) add('paused_all', 'warn', 'Scheduler paused. Nothing runs on its own.', null)
    if (this.headlessBlocked)
      add('headless_blocked', 'warn', 'Background runs are off until this is fixed. Session jobs are unaffected.', null)
    const held = all.filter((s) => s.today === 'held').length
    if (held) add('held_jobs', 'warn', `${held} jobs changed outside the app and are on hold.`, null)
    const both = all.filter((s) => s.runner === 'both').length
    if (both) add('legacy_both_runner', 'warn', `${both} jobs still have a background backup.`, null)
    const missed = all.filter((s) => s.today === 'missed').length
    if (missed) add('missed_recently', 'info', `${missed} jobs were missed in the last day.`, null)
    if (all.length > MAX_SCHEDULES_PER_SNAPSHOT)
      add('truncated', 'warn', `Showing ${MAX_SCHEDULES_PER_SNAPSHOT} of ${all.length} jobs.`, null)
    const state = issues.some((i) => i.severity === 'error')
      ? 'stuck'
      : this.pausedAll
        ? 'paused'
        : issues.some((i) => i.severity === 'warn')
          ? 'degraded'
          : 'ok'
    return {
      state,
      adapter: { id: 'fake', version: '0.3.0-fake', api: 1 },
      tz: this.tz,
      host_label: this.hostLabel,
      session_runner: this.sessionRunner,
      paused_all: this.pausedAll,
      headless: this.headlessBlocked ? 'blocked' : all.some((s) => s.runner !== 'session') ? 'ok' : 'unused',
      tick_age_s: 0,
      issues: issues.slice(0, 10),
      checked_at: since,
    }
  }

  async retryHeadless() {
    this.calls.push('retryHeadless')
    this.headlessBlocked = false
    return { ok: true, text: 'Background runs work again.' }
  }

  watchPaths(): string[] {
    return []
  }
}
