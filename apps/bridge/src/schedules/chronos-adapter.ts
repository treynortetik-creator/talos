// The production Chronos adapter (docs/SCHEDULES.md S3.1). It spawns `chronos api <verb>` with an argv array (never a
// shell), JSON on stdin and stdout, under the S2.4 timeout; it never reads or writes Chronos's files; there is no schedule
// maths in it. Output is parsed with the protocol's CHRONOS_API schemas: a snapshot row by row (one broken record is one
// `unreadable` entry plus an issue, never a dead list), anything else failing the schema is an AdapterError that the
// service turns into a `registry_unreadable` health issue carrying the zod path.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import {
  type ApplyResult,
  CHRONOS_API,
  type ChronosChangeT,
  type ChronosDetailT,
  type ChronosHealthT,
  type ChronosVerb,
  type ClaimResult,
  changeTimesProblem,
  DETAIL_PROMPT_MAX_BYTES,
  type DueForSession,
  type HealthIssueT,
  MAX_SCHEDULES_PER_SNAPSHOT,
  parseChronosDue,
  parseChronosOrphans,
  parseChronosSnapshot,
  type SchedulePreviewT,
  type SchedulerAdapter,
  type SchedulerHealthT,
  type ScheduleSnapshotT,
  type ScheduleT,
  type SessionPromptResult,
  scheduleFromChronos,
  type ValidateResult,
} from '@talos-app/protocol'

export class AdapterError extends Error {
  constructor(
    readonly kind: 'timeout' | 'parse' | 'spawn' | 'exit',
    message: string,
    /** The first failing zod path, for `registry_unreadable`. */
    readonly path?: string,
  ) {
    super(message)
  }
}

/** What the adapter needs from Talos's own sidecar to fill the Talos-only fields of a row (S3.5, N6). */
export type AdapterMeta = {
  threadOf(id: string): string | null
  /** Age in seconds of the sidecar's offer for (id, ds), or null. */
  offerAgeS(id: string, ds: string): number | null
}

export type ChronosAdapterOptions = {
  /** Absolute path to the `chronos` CLI (or a wrapper script). */
  bin: string
  /** CHRONOS_CONFIG. */
  config?: string | undefined
  /** S2.4: an adapter call is killed after this long. */
  timeoutMs: number
  /** CHRONOS_NOW (test builds only; the service refuses it in production). */
  chronosNow?: (() => string | undefined) | undefined
  /** Environment the child gets (no more than this plus Chronos's own variables). */
  env?: { path?: string; home?: string; tz?: string } | undefined
  meta?: AdapterMeta
  hostLabel?: string
  /** Clock for the single-flight window (the bridge's injected clock). */
  now?: () => number
  /** Told about every call that timed out or came back unreadable. */
  onProblem?: (e: AdapterError) => void
}

const SINGLE_FLIGHT_MS = 2000
/** Chronos's probe_timeout_s default (120 s) plus its own 5 s margin and ours. */
const PROBE_DEADLINE_MS = 135_000
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

type Err = { code: string; message: string; fields: Array<{ path: string; message: string }> }
const errOf = (x: unknown): Err | null => {
  const e = (x as { error?: Err } | null)?.error
  return e && typeof e.code === 'string' ? e : null
}
const mapCode = (c: string) => (c === 'not_found' ? 'schedule_not_found' : c)

const TCC_FIX =
  "macOS is probably waiting for permission. 1. At the Mac, look for a dialog saying Claude Code would like to access a folder and click Allow (it may be behind other windows). 2. Or open System Settings → Privacy & Security → Files and Folders and allow it. 3. Lasting fix: keep your agent folder outside Desktop, Documents and Downloads. 4. Tap Retry background runs. Session jobs aren't affected."

/** S7.2: severity, text, fix per code. */
const ISSUES: Record<string, [HealthIssueT['severity'], string, string | null]> = {
  session_runner_conflict: [
    'error',
    "Chronos's own session timers are still on, so Talos won't run jobs (to avoid running them twice).",
    'At the Mac run `talos-app schedules adopt`, then restart your session.',
  ],
  paused_all: ['warn', 'Scheduler paused. Nothing runs on its own.', 'Tap Resume.'],
  tick_missing: [
    'error',
    "Your scheduler hasn't checked in lately.",
    '1. Check the Mac is awake. 2. At the Mac run `chronos doctor`. 3. If the tick is stuck: `launchctl kickstart -k gui/$(id -u)/io.github.chronos.tick`.',
  ],
  launch_stalled: [
    'warn',
    'A background run is stuck.',
    'Read the run log in Schedules → Recent runs. If macOS is the cause, see "Background runs are stuck".',
  ],
  tcc_suspected: ['warn', 'Background runs are stuck. macOS is probably waiting for your permission.', TCC_FIX],
  headless_blocked: [
    'warn',
    'Background runs are off until this is fixed. Session jobs are unaffected.',
    `${TCC_FIX.split(' 4.')[0]} Then tap Retry background runs.`,
  ],
  run_hung: ['error', 'A background run is stuck.', 'At the Mac run `chronos doctor`; it lists the stuck process.'],
  adapter_timeout: [
    'error',
    "The scheduler didn't answer in time.",
    "The scheduler's files may be in a protected or cloud-synced folder that isn't available.",
  ],
  not_installed: ['info', 'No scheduler is installed on this Mac.', null],
  version_unsupported: ['warn', 'This Chronos is too old for Talos.', 'Update Chronos: `git pull && ./install.sh`.'],
  registry_unreadable: [
    'error',
    "Some of your scheduler's jobs can't be read.",
    "Fix jobs.json at the Mac or restore it from the scheduler's history.",
  ],
  registry_synced_folder: [
    'warn',
    "Your scheduler's files are in a synced folder.",
    "Move the scheduler's files to a local folder. One Mac per relay.",
  ],
  legacy_both_runner: [
    'warn',
    'Jobs still have a background backup.',
    'At the Mac run `talos-app schedules adopt` to turn the backup off.',
  ],
  held_jobs: [
    'warn',
    'Jobs changed outside the app and are on hold.',
    'Open each job and review the change. After an upgrade from Chronos 0.2, run `talos-app schedules adopt` at the Mac.',
  ],
  missed_recently: ['info', 'Jobs were missed in the last day.', "Missed jobs don't re-run on their own. Use Run now."],
  truncated: ['warn', 'Only the first 200 jobs are shown.', null],
}
/** Codes that Chronos reports once per job; the snapshot shows one issue for them all. */
const COLLAPSE = new Set(['held_jobs', 'missed_recently', 'legacy_both_runner'])
/** The beat is older than two tick intervals (5 min) plus a minute. */
const TICK_STALE_S = 2 * 300 + 60

export function issueFor(
  code: HealthIssueT['code'],
  since: string,
  scheduleId: string | null,
  text?: string,
): HealthIssueT {
  const [severity, t, fix] = ISSUES[code] ?? ['warn', code, null]
  return { code, severity, text: (text ?? t).slice(0, 200), fix, schedule_id: scheduleId, since }
}

/** health.state from the issues (S7.2 table). */
export function healthState(issues: HealthIssueT[], pausedAll: boolean): SchedulerHealthT['state'] {
  if (issues.some((i) => i.severity === 'error')) return 'stuck'
  if (pausedAll) return 'paused'
  if (issues.some((i) => i.severity === 'warn')) return 'degraded'
  return 'ok'
}

export class ChronosAdapter implements SchedulerAdapter {
  readonly id = 'chronos'
  private snap: { at: number; p: Promise<ScheduleSnapshotT> } | null = null
  private children = new Set<ReturnType<typeof spawn>>()
  private version: string | null = null
  private features: string[] = []
  /** Lists Chronos printed with an item we could not read (due, orphans): shown as a health issue until they read clean. */
  private unreadableLists = new Map<string, string[]>()
  private paths: string[] = []
  private ds = new Map<string, string>()

  constructor(private readonly o: ChronosAdapterOptions) {}

  private clock() {
    return (this.o.now ?? Date.now)()
  }

  /** Drops the single-flight cache (after any write, and when the bridge sees a file change). */
  invalidate() {
    this.snap = null
  }

  // ---- the process boundary ------------------------------------------------------------------------------------

  private env(): Record<string, string> {
    const e: Record<string, string> = {
      PATH: this.o.env?.path || DEFAULT_PATH,
      LANG: 'en_US.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1', // the vendored copy must not be dirtied by a run
    }
    if (this.o.env?.home) e.HOME = this.o.env.home
    if (this.o.env?.tz) e.TZ = this.o.env.tz
    if (this.o.config) e.CHRONOS_CONFIG = this.o.config
    const now = this.o.chronosNow?.()
    if (now) e.CHRONOS_NOW = now
    return e
  }

  /** Kills a child by PID (its own process group), never by name. */
  private kill(child: ReturnType<typeof spawn>) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  /** Shutdown: every call still in flight is killed (by PID) and rejects. */
  close() {
    for (const c of this.children) this.kill(c)
    this.children.clear()
  }

  /** `chronos api <args>` with `stdin` as JSON. Resolves with the parsed JSON, whatever its exit code. */
  raw(args: string[], stdin?: unknown, timeoutMs = this.o.timeoutMs, quiet = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(this.o.bin, ['api', ...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env(),
          detached: true,
        })
      } catch (e) {
        return reject(new AdapterError('spawn', `could not run ${this.o.bin}: ${(e as Error).message}`))
      }
      this.children.add(child)
      let out = ''
      let errText = ''
      let settled = false
      const finish = (f: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.children.delete(child)
        f()
      }
      const timer = setTimeout(() => {
        this.kill(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
        const e = new AdapterError(
          'timeout',
          `chronos api ${args[0]} did not answer within ${Math.round(timeoutMs / 1000)} s`,
        )
        finish(() => {
          if (!quiet) this.o.onProblem?.(e)
          reject(e)
        })
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        errText += d.toString('utf8')
      })
      child.on('error', (e) =>
        finish(() => reject(new AdapterError('spawn', `could not run ${this.o.bin}: ${e.message}`))),
      )
      child.on('close', (code) =>
        finish(() => {
          try {
            resolve(JSON.parse(out))
          } catch {
            const e = new AdapterError(
              'parse',
              `chronos api ${args[0]}: no JSON (exit ${code}): ${(errText || out).slice(0, 200)}`,
            )
            this.o.onProblem?.(e)
            reject(e)
          }
        }),
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdin === undefined ? '' : JSON.stringify(stdin))
    })
  }

  private async call<V extends ChronosVerb>(verb: V, args: string[], stdin?: unknown) {
    return this.parsed(verb, args, await this.raw(args, stdin))
  }

  /** `out` read with the schema for `verb`; a failure is reported (onProblem) and thrown with the first failing path. */
  private parsed<V extends ChronosVerb>(verb: V, args: string[], out: unknown) {
    const p = CHRONOS_API[verb].safeParse(out)
    if (!p.success) {
      const i = p.error.issues[0]
      const path = i?.path.join('.') || '(root)'
      const e = new AdapterError(
        'parse',
        `chronos api ${args[0]}: the answer does not parse at ${path}: ${i?.message ?? 'invalid'}`,
        path,
      )
      this.o.onProblem?.(e)
      throw e
    }
    return p.data as unknown
  }

  // ---- reads -------------------------------------------------------------------------------------------------

  async detect() {
    const v = (await this.call('version', ['version'])) as {
      api: number
      chronos: string
      session_runner: 'talos' | 'hook'
      features?: string[]
    }
    if (errOf(v)) return { installed: true, supported: false, reason: errOf(v)?.message ?? 'unsupported' }
    this.version = v.chronos
    this.features = v.features ?? []
    return {
      installed: true,
      supported: v.api === 1,
      version: v.chronos,
      api: v.api,
      sessionRunner: v.session_runner,
      features: this.features,
    }
  }

  snapshot(): Promise<ScheduleSnapshotT> {
    const now = this.clock()
    if (this.snap && now - this.snap.at < SINGLE_FLIGHT_MS) return this.snap.p
    const p = this.buildSnapshot()
    this.snap = { at: now, p }
    p.catch(() => {
      if (this.snap?.p === p) this.snap = null
    })
    return p
  }

  private async buildSnapshot(): Promise<ScheduleSnapshotT> {
    const out = await this.raw(['snapshot'])
    const failed = errOf(out)
    if (failed) throw new AdapterError('exit', `chronos api snapshot: ${failed.code}: ${failed.message}`)
    const p = parseChronosSnapshot(out)
    if (!p.ok) {
      const e = new AdapterError('parse', `chronos api snapshot: unreadable: ${p.message}`, p.message.split(':')[0])
      this.o.onProblem?.(e)
      throw e
    }
    this.paths = this.pathsFrom(p.head.jobs_file, p.head.state_dir)
    const meta = this.o.meta
    this.ds.clear()
    const schedules = p.jobs.map((j) => {
      this.ds.set(j.id, j.ds)
      return scheduleFromChronos(j, {
        thread_id: (meta?.threadOf(j.id) ?? null) as ScheduleT['thread_id'],
        offerAgeS: meta?.offerAgeS(j.id, j.ds) ?? null,
        sessionBeatAgeS: p.head.session_beat_age_s,
      })
    })
    const health = await this.healthFrom(p.head, schedules, p.unreadable)
    return {
      protocol: 1,
      health,
      schedules: schedules.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
      unreadable: p.unreadable.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
      as_of: p.head.as_of,
    }
  }

  async detail(id: string, _reportRunId: string | null) {
    const d = await this.call('detail', ['detail', id])
    if (errOf(d)) return null
    const x = d as ChronosDetailT
    const enc = new TextEncoder()
    let prompt = x.prompt
    while (enc.encode(prompt).length > DETAIL_PROMPT_MAX_BYTES) prompt = prompt.slice(0, -1024)
    this.ds.set(id, x.schedule.ds)
    return {
      detail: {
        schedule: scheduleFromChronos(x.schedule, {
          thread_id: (this.o.meta?.threadOf(id) ?? null) as ScheduleT['thread_id'],
          offerAgeS: this.o.meta?.offerAgeS(id, x.schedule.ds) ?? null,
        }),
        prompt,
        prompt_truncated: x.prompt_truncated || prompt !== x.prompt,
        guard: x.guard,
        next_runs: x.next_runs,
        runs: x.runs.slice(0, 10),
      },
      report: null,
    }
  }

  /** The `ds` the last snapshot or detail reported for a job (its current day), without another spawn. */
  dayOf(id: string): string | undefined {
    return this.ds.get(id)
  }

  // ---- the one writer -------------------------------------------------------------------------------------------

  async validate(change: ChronosChangeT): Promise<ValidateResult> {
    // Chronos's own floor between fire times is 15 minutes; Talos's is 60 (HEARTBEAT-SPEC 7a). The owner form and the agent
    // are held to it by the ScheduleChange schema; this is the same rule at the last door, so a change built any other way
    // is refused in words instead of being sent, or read back as an unreadable answer.
    const tooClose = changeTimesProblem(change)
    if (tooClose) return { ok: false, code: 'schedule_invalid', errors: [{ path: 'when.times', message: tooClose }] }
    const out = await this.raw(['validate'], change)
    const answerTooClose = changeTimesProblem((out as { normalized?: unknown } | null)?.normalized)
    if (answerTooClose && !errOf(out))
      return { ok: false, code: 'schedule_invalid', errors: [{ path: 'when.times', message: answerTooClose }] }
    const v = this.parsed('validate', ['validate'], out)
    const e = errOf(v)
    if (e) {
      const code =
        (['schedule_not_found', 'held', 'schedule_conflict'] as const).find((c) => c === mapCode(e.code)) ??
        'schedule_invalid'
      return { ok: false, code, errors: e.fields.length ? e.fields : [{ path: '', message: e.message }] }
    }
    const r = v as { normalized: ChronosChangeT; preview: SchedulePreviewT; expected_etag: string | null }
    return { ok: true, normalized: r.normalized, preview: r.preview, expectedEtag: r.expected_etag }
  }

  async apply(change: ChronosChangeT, expectedEtag: string | null): Promise<ApplyResult> {
    this.invalidate()
    const a = await this.call('apply', ['apply'], { change, expected_etag: expectedEtag })
    this.invalidate()
    const e = errOf(a)
    if (e) {
      const code =
        (['schedule_conflict', 'held', 'schedule_not_found'] as const).find((c) => c === mapCode(e.code)) ??
        'schedule_invalid'
      return { ok: false, code, message: e.message }
    }
    return { ok: true, etag: (a as { etag: string | null }).etag }
  }

  async setPaused(scope: { id: string } | 'all', paused: boolean) {
    this.invalidate()
    const r = await this.call('pause', ['pause'], { scope, paused })
    this.invalidate()
    const e = errOf(r)
    if (e) throw new AdapterError('exit', `pause: ${e.code}: ${e.message}`)
  }

  async disable(id: string) {
    this.invalidate()
    const r = await this.call('disable', ['disable', id])
    this.invalidate()
    const e = errOf(r)
    if (e) throw new AdapterError('exit', `disable: ${e.code}: ${e.message}`)
    return { etag: (r as { etag: string }).etag }
  }

  async approved(id: string) {
    const r = (await this.call('approved', ['approved', id])) as {
      content_hash: string
      prompt: string
      guard: string | null
      approved_at: string
    } | null
    if (!r || errOf(r)) return null
    return { contentHash: r.content_hash, prompt: r.prompt, guard: r.guard, approvedAt: r.approved_at }
  }

  /** `chronos api config set ...` for `talos-app schedules adopt` (S3.7). Chronos refuses while a `both` job remains. */
  async configSet(c: {
    sessionRunner?: 'talos' | 'hook'
    approvalRequired?: boolean
  }): Promise<{ ok: true } | { ok: false; code: string; message: string; blocking: string[] }> {
    const args: string[] = []
    if (c.sessionRunner) args.push('session_runner', c.sessionRunner)
    if (c.approvalRequired !== undefined) args.push('approval_required', String(c.approvalRequired))
    this.invalidate()
    const r = await this.call('config_set', ['config', 'set', ...args])
    this.invalidate()
    const e = errOf(r)
    if (e) {
      const blocking = (e.fields ?? []).map((f) => f.path).filter(Boolean)
      return { ok: false, code: e.code, message: e.message, blocking }
    }
    return { ok: true }
  }

  // ---- runs ------------------------------------------------------------------------------------------------------

  async dueForSession(): Promise<DueForSession[]> {
    const r = await this.call('due_session', ['due', '--for', 'session'])
    const e = errOf(r)
    if (e) throw new AdapterError('exit', `due: ${e.code}: ${e.message}`)
    // one slot that can't be read costs that slot, not the list; it is reported until Chronos prints it readably
    const due = parseChronosDue(r)
    if (!due.ok) throw new AdapterError('parse', `chronos api due: ${due.message}`)
    this.noteUnreadable('due', due.bad)
    return due.due
  }

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
    this.invalidate()
    const r = await this.call('claim', ['claim', id], {
      run_id: a.runId,
      ds: a.ds,
      fire_at: a.fireAt,
      manual: a.manual,
      again: a.again,
      runner: 'session',
      bridge_instance: a.bridgeInstance,
    })
    this.invalidate()
    const e = errOf(r)
    if (e) {
      const code = mapCode(e.code)
      if (code === 'schedule_invalid' || code === 'schedule_not_found') return { ok: false, reason: code }
      throw new AdapterError('exit', `claim: ${e.code}: ${e.message}`)
    }
    const c = r as
      | { ok: true; run_id: string; ds: string }
      | { ok: false; reason: Exclude<ClaimResult, { ok: true }>['reason'] }
    return c.ok ? { ok: true, runId: c.run_id, ds: c.ds } : { ok: false, reason: c.reason }
  }

  async finish(
    id: string,
    a: { runId: string; status: 'ok' | 'failed' | 'timed_out' | 'session_ended'; report: string },
  ) {
    this.invalidate()
    const r = await this.call('finish', ['finish', id], { run_id: a.runId, status: a.status, report: a.report })
    this.invalidate()
    const e = errOf(r)
    if (e) {
      if (mapCode(e.code) === 'schedule_not_found') return { ok: false as const, reason: 'not_owner' as const }
      throw new AdapterError('exit', `finish: ${e.code}: ${e.message}`)
    }
    return r as { ok: true } | { ok: false; reason: 'not_owner' | 'late' }
  }

  async orphanedSessionClaims(current: string) {
    const r = await this.call('orphans', ['orphans', '--bridge-instance', current])
    const e = errOf(r)
    if (e) throw new AdapterError('exit', `orphans: ${e.code}: ${e.message}`)
    const read = parseChronosOrphans(r)
    if (!read.ok) throw new AdapterError('parse', `chronos api orphans: ${read.message}`)
    this.noteUnreadable('orphans', read.bad)
    return read.orphans.map((o) => ({
      id: o.id,
      ds: o.ds,
      runId: o.run_id,
      bridgeInstance: o.bridge_instance ?? '',
    }))
  }

  private noteUnreadable(list: string, bad: string[]) {
    if (bad.length) {
      this.unreadableLists.set(list, bad)
      this.o.onProblem?.(new AdapterError('parse', `chronos api ${list}: ${bad.join('; ')}`.slice(0, 400)))
    } else this.unreadableLists.delete(list)
  }

  /** What Chronos supports beyond api 1 (`times`, `meta`), as its `version` said at discovery. */
  hasFeature(f: string): boolean {
    return this.features.includes(f)
  }

  async startHeadless(id: string, a: { again: boolean }) {
    this.invalidate()
    const r = await this.call('start', ['start', id], { again: a.again })
    this.invalidate()
    const e = errOf(r)
    if (e)
      return {
        ok: false as const,
        code:
          mapCode(e.code) === 'schedule_not_found' ? ('schedule_not_found' as const) : ('schedule_invalid' as const),
        message: e.message,
      }
    const s = r as
      | { ok: true; run_id: string; ds: string }
      | { ok: false; code: 'already_running' | 'headless_blocked' | 'held' | 'schedule_invalid'; message: string }
    return s.ok ? { ok: true as const, runId: s.run_id, ds: s.ds } : s
  }

  async sessionPrompt(id: string): Promise<SessionPromptResult> {
    const r = await this.call('session_prompt', ['session-prompt', id])
    const e = errOf(r)
    if (e) {
      const code = mapCode(e.code)
      if (code === 'held' || code === 'schedule_invalid' || code === 'schedule_not_found') return { ok: false, code }
      throw new AdapterError('exit', `session-prompt: ${e.code}: ${e.message}`)
    }
    const p = r as { guard: string | null; prompt: string; content_hash: string }
    return { ok: true, guard: p.guard, prompt: p.prompt, contentHash: p.content_hash }
  }

  // ---- health ----------------------------------------------------------------------------------------------------

  async health(): Promise<SchedulerHealthT> {
    const out = await this.raw(['snapshot'])
    const p = parseChronosSnapshot(out)
    if (!p.ok)
      throw new AdapterError('parse', `chronos api snapshot: unreadable: ${p.message}`, p.message.split(':')[0])
    const schedules = p.jobs.map((j) => scheduleFromChronos(j, { thread_id: null, offerAgeS: null }))
    return this.healthFrom(p.head, schedules, p.unreadable)
  }

  private async healthFrom(
    head: {
      as_of: string
      tz: string
      session_runner: 'talos' | 'hook'
      approval_required: boolean
      paused_all: boolean
      tick_age_s: number | null
      registry_synced_folder: boolean
    },
    jobs: ScheduleT[],
    unreadable: Array<{ id: string; unreadable: string }>,
  ): Promise<SchedulerHealthT> {
    const answer = await this.call('health', ['health'])
    const failed = errOf(answer)
    // Chronos v0.3.0 answers `health` with registry_unreadable on an install with no jobs.json yet, although `snapshot`
    // reads it as empty. Until that is fixed upstream an unreadable health answer is an issue, not a crash.
    const h: ChronosHealthT = failed
      ? {
          as_of: head.as_of,
          tz: head.tz,
          session_runner: head.session_runner,
          paused_all: head.paused_all,
          tick_age_s: head.tick_age_s,
          session_beat_age_s: null,
          headless: 'unknown',
          blocked: null,
          tcc_suspected: false,
          claude_path_changed: false,
          registry_synced_folder: head.registry_synced_folder,
          issues:
            failed.code === 'registry_unreadable' && jobs.length === 0
              ? []
              : [{ code: 'registry_unreadable', schedule_id: null }],
        }
      : (answer as ChronosHealthT)
    const since = h.as_of
    const issues: HealthIssueT[] = []
    const add = (i: HealthIssueT) => {
      if (!issues.some((x) => x.code === i.code && x.schedule_id === i.schedule_id)) issues.push(i)
    }
    if (h.session_runner !== 'talos' || !head.approval_required) add(issueFor('session_runner_conflict', since, null))
    if (h.paused_all) add(issueFor('paused_all', since, null))
    const grouped = new Map<string, string[]>()
    for (const i of h.issues) {
      if (!ISSUES[i.code]) continue
      if (COLLAPSE.has(i.code)) {
        grouped.set(i.code, [...(grouped.get(i.code) ?? []), ...(i.schedule_id ? [i.schedule_id] : [])])
        continue
      }
      add(issueFor(i.code as HealthIssueT['code'], since, i.schedule_id))
    }
    for (const [code, ids] of grouped) {
      const [, base] = ISSUES[code] as [string, string, string | null]
      const text = ids.length ? `${base.replace(/\.$/, '')}: ${ids.join(', ')}.` : base
      add(issueFor(code as HealthIssueT['code'], since, ids.length === 1 ? (ids[0] as string) : null, text))
    }
    if (h.tcc_suspected) add(issueFor('tcc_suspected', since, null))
    if (h.registry_synced_folder) add(issueFor('registry_synced_folder', since, null))
    if (h.tick_age_s !== null && h.tick_age_s > TICK_STALE_S) add(issueFor('tick_missing', since, null))
    const lists = this.unreadableLists.size
      ? ` Some scheduled runs can't be read either (${[...this.unreadableLists.keys()].join(', ')}); the rest still run.`
      : ''
    if (unreadable.length)
      add(
        issueFor(
          'registry_unreadable',
          since,
          null,
          `Some of your scheduler's jobs can't be read: ${unreadable.map((u) => u.id).join(', ')}.${lists}`,
        ),
      )
    else if (lists) add(issueFor('registry_unreadable', since, null, lists.trim()))
    if (jobs.length > MAX_SCHEDULES_PER_SNAPSHOT) add(issueFor('truncated', since, null))
    const order = { error: 0, warn: 1, info: 2 } as const
    issues.sort((a, b) => order[a.severity] - order[b.severity])
    return {
      state: healthState(issues, h.paused_all),
      adapter: { id: 'chronos', version: this.version, api: 1 },
      tz: h.tz,
      host_label: this.o.hostLabel ?? 'This Mac',
      session_runner: h.session_runner,
      paused_all: h.paused_all,
      headless: h.headless,
      tick_age_s: h.tick_age_s,
      issues: issues.slice(0, 10),
      checked_at: h.as_of,
    }
  }

  /**
   * `chronos api probe` runs one launchd job and waits up to Chronos's `probe_timeout_s` (120 s by default; its README says
   * not to wait on it synchronously). It gets its own deadline, past that, and a slow answer is never a health problem.
   */
  async retryHeadless() {
    this.invalidate()
    const out = await this.raw(['probe'], undefined, PROBE_DEADLINE_MS, true)
    this.invalidate()
    const e = errOf(out)
    if (e) return { ok: false, text: e.message }
    const p = CHRONOS_API.probe.safeParse(out)
    if (!p.success) return { ok: false, text: 'The probe answered something unreadable.' }
    const r = p.data as { ok: boolean; text: string }
    return { ok: r.ok, text: r.text }
  }

  private pathsFrom(jobsFile: string, stateDir: string): string[] {
    const cfgDir = dirname(jobsFile)
    // the state dir's parent holds PAUSED, paused-jobs/ and headless.blocked; jobs/ holds the prompts
    return [jobsFile, cfgDir, join(cfgDir, 'jobs'), stateDir, dirname(stateDir)]
  }

  watchPaths(): string[] {
    return this.paths
  }
}
