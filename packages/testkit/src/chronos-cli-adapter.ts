// ChronosCliAdapter: a thin SchedulerAdapter over the REAL vendored Chronos CLI (third_party/chronos), for tests. It is
// how defineSchedulerAdapterContract runs against real Chronos (temp HOME, TZ, fixed CHRONOS_NOW), so a case that the
// fake passes and Chronos fails (or the reverse) is caught in this repo. WP-S1's production adapter has the same
// mapping plus timeouts, queues and single-flight; it may start from this file.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ApplyResult,
  CHRONOS_API,
  type ChronosChangeT,
  type ChronosDetailT,
  type ChronosHealthT,
  type ChronosVerb,
  type ClaimResult,
  DETAIL_PROMPT_MAX_BYTES,
  type DueForSession,
  type HealthIssueT,
  MAX_SCHEDULES_PER_SNAPSHOT,
  parseChronosSnapshot,
  type SchedulePreviewT,
  type SchedulerAdapter,
  type SchedulerHealthT,
  type ScheduleSnapshotT,
  type SessionPromptResult,
  scheduleFromChronos,
  type ValidateResult,
} from '@talos-app/protocol'

const here = dirname(fileURLToPath(import.meta.url))
export const VENDORED_CHRONOS = join(here, '..', '..', '..', 'third_party', 'chronos')

/** python3 >= 3.9 on PATH (Chronos is stdlib-only). */
export function hasPython3(): boolean {
  const r = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], {
    encoding: 'utf8',
  })
  return r.status === 0
}

type Out = { exit: number; out: unknown }

export class ChronosCliError extends Error {}

const CODE: Record<string, string> = { not_found: 'schedule_not_found' }
const mapCode = (c: string) => CODE[c] ?? c

const ISSUE_TEXT: Record<string, [HealthIssueT['severity'], string]> = {
  session_runner_conflict: [
    'error',
    "Chronos's own session timers are still on, so Talos won't run jobs (to avoid running them twice).",
  ],
  paused_all: ['warn', 'Scheduler paused. Nothing runs on its own.'],
  tick_missing: ['error', "Your scheduler hasn't checked in lately."],
  launch_stalled: ['error', 'A background run is stuck.'],
  run_hung: ['error', 'A background run is stuck.'],
  tcc_suspected: ['warn', 'Background runs are stuck. macOS is probably waiting for your permission.'],
  headless_blocked: ['warn', 'Background runs are off until this is fixed. Session jobs are unaffected.'],
  held_jobs: ['warn', 'Jobs changed outside the app and are on hold.'],
  legacy_both_runner: ['warn', 'Jobs still have a background backup.'],
  missed_recently: ['info', 'Jobs were missed in the last day.'],
  registry_synced_folder: ['warn', "Your scheduler's files are in a synced folder."],
  registry_unreadable: ['error', "Some of your scheduler's jobs can't be read."],
  truncated: ['warn', 'Only the first 200 jobs are shown.'],
}

export class ChronosCliAdapter implements SchedulerAdapter {
  readonly id = 'chronos'
  readonly home: string
  private now: string
  constructor(private opts: { tz: string; now: string; root?: string; home?: string; python?: string }) {
    this.home = opts.home ?? mkdtempSync(join(tmpdir(), 'chronos-contract-'))
    this.now = opts.now
  }

  setNow(iso: string) {
    this.now = iso
  }
  /** A local process rewriting prompt.md: no apply, no approval. */
  editPromptOutside(id: string, prompt: string) {
    const dir = join(this.home, '.config', 'chronos', 'jobs', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'prompt.md'), prompt)
  }
  /** Chronos config switches (`chronos api config set ...`). */
  configure(c: { sessionRunner?: 'talos' | 'hook'; approvalRequired?: boolean }) {
    const args: string[] = []
    if (c.sessionRunner) args.push('session_runner', c.sessionRunner)
    if (c.approvalRequired !== undefined) args.push('approval_required', String(c.approvalRequired))
    if (args.length) this.call('config_set', ['config', 'set', ...args])
  }
  dispose() {
    if (!this.opts.home && existsSync(this.home)) rmSync(this.home, { recursive: true, force: true })
  }

  /** Runs one `chronos api` verb. Returns the parsed answer (success or the error envelope). */
  raw(args: string[], stdin?: unknown): Out {
    const bin = join(this.opts.root ?? VENDORED_CHRONOS, 'bin', 'chronos')
    const r = spawnSync(this.opts.python ?? 'python3', [bin, 'api', ...args], {
      input: stdin === undefined ? '' : JSON.stringify(stdin),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        HOME: this.home,
        TZ: this.opts.tz,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        CHRONOS_NOW: this.now,
        CHRONOS_TEST_MODE: '1',
      },
    })
    let out: unknown = null
    try {
      out = JSON.parse(r.stdout)
    } catch {
      throw new ChronosCliError(`chronos api ${args.join(' ')}: no JSON (exit ${r.status}): ${r.stderr.slice(0, 300)}`)
    }
    return { exit: r.status ?? -1, out }
  }

  private call(verb: ChronosVerb, args: string[], stdin?: unknown): unknown {
    const { out } = this.raw(args, stdin)
    const p = CHRONOS_API[verb].safeParse(out)
    if (!p.success)
      throw new ChronosCliError(`chronos api ${args[0]}: answer does not parse: ${JSON.stringify(p.error.issues[0])}`)
    return p.data
  }

  private err(x: unknown): { code: string; message: string; fields: Array<{ path: string; message: string }> } | null {
    const e = (x as { error?: { code: string; message: string; fields: Array<{ path: string; message: string }> } })
      ?.error
    return e ? { ...e, code: mapCode(e.code) } : null
  }

  async detect() {
    const v = this.call('version', ['version']) as { api: number; chronos: string; session_runner: 'talos' | 'hook' }
    return { installed: true, supported: v.api === 1, version: v.chronos, api: v.api, sessionRunner: v.session_runner }
  }

  async snapshot(): Promise<ScheduleSnapshotT> {
    const { out } = this.raw(['snapshot'])
    const p = parseChronosSnapshot(out)
    if (!p.ok) throw new ChronosCliError(`snapshot unreadable: ${p.message}`)
    const schedules = p.jobs.map((j) =>
      scheduleFromChronos(j, { thread_id: null, offerAgeS: null, sessionBeatAgeS: p.head.session_beat_age_s }),
    )
    const health = await this.healthFrom(p.head.approval_required, p.unreadable.length, schedules.length)
    return {
      protocol: 1,
      health,
      schedules: schedules.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
      unreadable: p.unreadable.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
      as_of: p.head.as_of,
    }
  }

  async detail(id: string, _reportRunId: string | null) {
    const d = this.call('detail', ['detail', id])
    if (this.err(d)) return null
    const x = d as ChronosDetailT
    const enc = new TextEncoder()
    let prompt = x.prompt
    while (enc.encode(prompt).length > DETAIL_PROMPT_MAX_BYTES) prompt = prompt.slice(0, -1024)
    return {
      detail: {
        schedule: scheduleFromChronos(x.schedule, { thread_id: null, offerAgeS: null }),
        prompt,
        prompt_truncated: x.prompt_truncated || prompt !== x.prompt,
        guard: x.guard,
        next_runs: x.next_runs,
        runs: x.runs.slice(0, 10),
      },
      report: null,
    }
  }

  async validate(change: ChronosChangeT): Promise<ValidateResult> {
    const v = this.call('validate', ['validate'], change)
    const e = this.err(v)
    if (e) {
      const code =
        (['schedule_not_found', 'held', 'schedule_conflict'] as const).find((c) => c === e.code) ?? 'schedule_invalid'
      return { ok: false, code, errors: e.fields.length ? e.fields : [{ path: '', message: e.message }] }
    }
    const r = v as { normalized: ChronosChangeT; preview: SchedulePreviewT; expected_etag: string | null }
    return { ok: true, normalized: r.normalized, preview: r.preview, expectedEtag: r.expected_etag }
  }

  async apply(change: ChronosChangeT, expectedEtag: string | null): Promise<ApplyResult> {
    const a = this.call('apply', ['apply'], { change, expected_etag: expectedEtag })
    const e = this.err(a)
    if (e) {
      const code =
        (['schedule_conflict', 'held', 'schedule_not_found'] as const).find((c) => c === e.code) ?? 'schedule_invalid'
      return { ok: false as const, code, message: e.message }
    }
    return { ok: true as const, etag: (a as { etag: string | null }).etag }
  }

  async setPaused(scope: { id: string } | 'all', paused: boolean) {
    const r = this.call('pause', ['pause'], { scope, paused })
    const e = this.err(r)
    if (e) throw new ChronosCliError(`pause: ${e.code} ${e.message}`)
  }

  async disable(id: string) {
    const r = this.call('disable', ['disable', id])
    const e = this.err(r)
    if (e) throw new ChronosCliError(`disable: ${e.code} ${e.message}`)
    return { etag: (r as { etag: string }).etag }
  }

  async approved(id: string) {
    const r = this.call('approved', ['approved', id]) as {
      content_hash: string
      prompt: string
      guard: string | null
      approved_at: string
    } | null
    if (!r || this.err(r)) return null
    return { contentHash: r.content_hash, prompt: r.prompt, guard: r.guard, approvedAt: r.approved_at }
  }

  async dueForSession(): Promise<DueForSession[]> {
    const r = this.call('due_session', ['due', '--for', 'session'])
    const e = this.err(r)
    if (e) throw new ChronosCliError(`due: ${e.code} ${e.message}`)
    return (r as { due: DueForSession[] }).due
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
    const r = this.call('claim', ['claim', id], {
      run_id: a.runId,
      ds: a.ds,
      fire_at: a.fireAt,
      manual: a.manual,
      again: a.again,
      runner: 'session',
      bridge_instance: a.bridgeInstance,
    })
    const e = this.err(r)
    if (e) {
      if (e.code === 'schedule_invalid' || e.code === 'schedule_not_found') return { ok: false, reason: e.code }
      throw new ChronosCliError(`claim: ${e.code} ${e.message}`)
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
    const r = this.call('finish', ['finish', id], { run_id: a.runId, status: a.status, report: a.report })
    const e = this.err(r)
    if (e) throw new ChronosCliError(`finish: ${e.code} ${e.message}`)
    return r as { ok: true } | { ok: false; reason: 'not_owner' | 'late' }
  }

  async orphanedSessionClaims(current: string) {
    const r = this.call('orphans', ['orphans', '--bridge-instance', current])
    const e = this.err(r)
    if (e) throw new ChronosCliError(`orphans: ${e.code} ${e.message}`)
    return (r as { orphans: Array<{ id: string; ds: string; run_id: string; bridge_instance?: string }> }).orphans.map(
      (o) => ({
        id: o.id,
        ds: o.ds,
        runId: o.run_id,
        bridgeInstance: o.bridge_instance ?? '',
      }),
    )
  }

  async startHeadless(id: string, a: { again: boolean }) {
    const r = this.call('start', ['start', id], { again: a.again })
    const e = this.err(r)
    if (e)
      return {
        ok: false as const,
        code: e.code === 'schedule_not_found' ? ('schedule_not_found' as const) : ('schedule_invalid' as const),
        message: e.message,
      }
    const s = r as
      | { ok: true; run_id: string; ds: string }
      | { ok: false; code: 'already_running' | 'headless_blocked' | 'held' | 'schedule_invalid'; message: string }
    return s.ok ? { ok: true as const, runId: s.run_id, ds: s.ds } : s
  }

  async sessionPrompt(id: string): Promise<SessionPromptResult> {
    const r = this.call('session_prompt', ['session-prompt', id])
    const e = this.err(r)
    if (e) {
      if (e.code === 'held' || e.code === 'schedule_invalid' || e.code === 'schedule_not_found')
        return { ok: false, code: e.code }
      throw new ChronosCliError(`session-prompt: ${e.code} ${e.message}`)
    }
    const p = r as { guard: string | null; prompt: string; content_hash: string }
    return { ok: true, guard: p.guard, prompt: p.prompt, contentHash: p.content_hash }
  }

  async health(): Promise<SchedulerHealthT> {
    const v = this.call('version', ['version']) as { approval_required: boolean }
    return this.healthFrom(v.approval_required, 0, null)
  }

  private async healthFrom(
    approvalRequired: boolean,
    unreadable: number,
    jobs: number | null,
  ): Promise<SchedulerHealthT> {
    const answer = this.call('health', ['health'])
    const failed = this.err(answer)
    // Chronos v0.3.0 answers `health` with registry_unreadable on an install with no jobs.json yet, although
    // `snapshot` reads it as empty. Reported upstream; until then an unreadable health answer is an issue, not a crash.
    const h: ChronosHealthT = failed
      ? {
          as_of: (this.raw(['snapshot']).out as { as_of?: string }).as_of ?? new Date().toISOString(), // read-only
          tz: this.opts.tz,
          session_runner: (await this.detect()).sessionRunner ?? 'hook',
          paused_all: false,
          tick_age_s: null,
          session_beat_age_s: null,
          headless: 'unknown',
          blocked: null,
          tcc_suspected: false,
          claude_path_changed: false,
          registry_synced_folder: false,
          issues:
            failed.code === 'registry_unreadable' && jobs === 0
              ? []
              : [{ code: 'registry_unreadable', schedule_id: null }],
        }
      : (answer as ChronosHealthT)
    const issues: HealthIssueT[] = []
    const add = (code: string, schedule_id: string | null) => {
      const [severity, text] = ISSUE_TEXT[code] ?? ['warn', code]
      if (issues.some((i) => i.code === code && i.schedule_id === schedule_id)) return
      issues.push({ code: code as HealthIssueT['code'], severity, text, fix: null, schedule_id, since: h.as_of })
    }
    if (h.session_runner !== 'talos' || !approvalRequired) add('session_runner_conflict', null)
    if (h.paused_all) add('paused_all', null)
    for (const i of h.issues) if (ISSUE_TEXT[i.code]) add(i.code, i.schedule_id)
    if (unreadable) add('registry_unreadable', null)
    if (jobs !== null && jobs > MAX_SCHEDULES_PER_SNAPSHOT) add('truncated', null)
    const state = issues.some((i) => i.severity === 'error')
      ? 'stuck'
      : h.paused_all
        ? 'paused'
        : issues.some((i) => i.severity === 'warn')
          ? 'degraded'
          : 'ok'
    return {
      state,
      adapter: { id: 'chronos', version: null, api: 1 },
      tz: h.tz,
      host_label: 'Example Mac',
      session_runner: h.session_runner,
      paused_all: h.paused_all,
      headless: h.headless,
      tick_age_s: h.tick_age_s,
      issues: issues.slice(0, 10),
      checked_at: h.as_of,
    }
  }

  async retryHeadless() {
    const r = this.call('probe', ['probe']) as { ok: boolean; text: string }
    return { ok: r.ok, text: r.text }
  }

  watchPaths(): string[] {
    return [join(this.home, '.config', 'chronos', 'jobs.json'), join(this.home, '.chronos')]
  }
}
