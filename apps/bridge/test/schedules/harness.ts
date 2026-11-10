// Harness for the Schedules bridge tests (docs/SCHEDULES.md S9, WP-S1). The seam under test is the REAL bridge (live,
// in process, on an injected clock) talking to the REAL Chronos CLI (third_party/chronos) in a temp HOME, with FakeRelay
// and FakeApp at the far end and `FakeAgent` standing in for the Claude session. Chronos's own clock follows the
// bridge's injected clock through `chronosNow`, so a 60 s loop, a midnight and a restart are real Chronos decisions.
import { setDefaultTimeout } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChronosDraftT, newUlid } from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import type { Notification } from '../../src/notify.ts'
import { advanceSteps, type Harness, sleep, startHarness, tempHome, waitFor } from '../helpers.ts'
import { ChronosBox, MON_0700_EDT } from './chronos-box.ts'

/**
 * Real Chronos processes and minutes of injected time: bun's 5 s per test is too tight. Bun applies the default per test FILE,
 * so every file calls this at its top (this module is evaluated once per run, not once per file).
 */
export function longTimeouts() {
  setDefaultTimeout(60_000)
}
longTimeouts()

export { CHRONOS_SRC, ChronosBox, draft, MON_0700_EDT, REPO, TZ } from './chronos-box.ts'

/** A signed request frame as FakeApp returns it. */
export type Req = { id: string; request_id: string }

export type SchedHarness = Harness & {
  clock: FakeClock
  box: ChronosBox
  agent: FakeAgent
  /** Advances the injected clock (bridge and Chronos) and lets sockets breathe. */
  /** Moves the fake clock by `ms`. By default it ends with one runner tick at the final time (`catchUp: false` skips it: the capture step pins every step). */
  advance(ms: number, opts?: { catchUp?: boolean }): Promise<void>
  noteKinds(): string[]
  /** Notifications of one kind, in order. */
  notesOf(kind: string): Notification[]
}

export async function startSched(
  opts: {
    now?: string
    jobs?: ChronosDraftT[]
    sessionRunner?: 'talos' | 'hook'
    approvalRequired?: boolean
    env?: Record<string, string>
    startBridge?: boolean
    home?: string
    box?: ChronosBox
    instance?: string
    headless?: boolean
    /** Edits the starting config.json (trust mode, say) before the bridge reads it. */
    config?: NonNullable<Parameters<typeof startHarness>[0]>['config']
    /** Test seam: wraps the scheduler adapter the bridge discovered. */
    wrapAdapter?: NonNullable<import('../../src/bridge-options.ts').BridgeOptions['wrapSchedulerAdapter']>
    /** The heartbeat runner's test seams (wake, work gate, time scale, crash hooks, the `gh` path). */
    heartbeat?: NonNullable<import('../../src/bridge-options.ts').BridgeOptions['heartbeat']>
    /** Discovery's budget for `chronos api version` (ms); a test that stalls it passes a short one. */
    discoveryTimeoutMs?: number
    /** Chronos's clock when it should NOT follow the injected clock (the capture step pins it per step). */
    chronosNow?: () => string
    /** fs.watch on Chronos's files; the capture step turns it off so its output is deterministic. */
    scheduleWatch?: boolean
    relay?: Parameters<typeof startHarness>[0] extends infer O ? (O extends { relay?: infer R } ? R : never) : never
  } = {},
): Promise<SchedHarness> {
  const now = opts.now ?? MON_0700_EDT
  const clock = fakeClock(now)
  const box = opts.box ?? new ChronosBox(now)
  if (!opts.box) {
    box.configure({ sessionRunner: opts.sessionRunner ?? 'talos', approvalRequired: opts.approvalRequired ?? true })
    for (const j of opts.jobs ?? []) box.create(j)
  }
  const h = await startHarness({
    clock,
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.relay ? { relay: opts.relay } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.startBridge !== undefined ? { startBridge: opts.startBridge } : {}),
    env: { TALOS_APP_CHRONOS_BIN: box.bin, TALOS_APP_CHRONOS_CONFIG: box.configFile, ...opts.env },
    bridge: {
      chronosNow: opts.chronosNow ?? (() => new Date(clock.now()).toISOString()),
      ...(opts.scheduleWatch === false ? { scheduleWatch: false } : {}),
      instance: opts.instance ?? `bi_${newUlid().slice(-10)}`,
      ...(opts.headless ? { headless: true } : {}),
      ...(opts.heartbeat ? { heartbeat: opts.heartbeat } : {}),
      ...(opts.wrapAdapter ? { wrapSchedulerAdapter: opts.wrapAdapter } : {}),
      ...(opts.discoveryTimeoutMs ? { discoveryTimeoutMs: opts.discoveryTimeoutMs } : {}),
    },
  })
  // the bridge batches the relay's post-`ready` replay behind a settle timer; on the injected clock it needs a nudge.
  // startHarness returned only once the bridge's socket was authed, which runs onReady in the same tick, so the timer
  // is armed and this one advance closes it. Then wait for the schedule loops to be on the clock: start() spawns real
  // Chronos and arms after its first tick, and an advance before that fires nothing.
  if (opts.startBridge !== false) {
    clock.advance(300)
    const svc = h.bridge.ctx.schedules
    if (svc?.hasStarted) await waitFor(() => svc.armed, 15_000, 'the schedule loops to arm')
  }
  // FakeApp stamps real time; the bridge runs on the injected clock, so signed frames carry the injected `now` (the
  // bridge checks `ts` against its own clock). A test that wants an exact `ts` (staleness) passes `keep_ts: true`.
  const app = h.app as unknown as { sign: (f: Record<string, unknown>) => Promise<Record<string, unknown>> }
  const realSign = app.sign.bind(h.app)
  app.sign = (f) => {
    const { keep_ts, ...rest } = f
    return realSign(keep_ts ? rest : { ...rest, ts: new Date(clock.now()).toISOString() })
  }
  // spawning real Chronos is slower on a busy CI box than the testkit's 3 s default for "a frame arrives"
  for (const target of [h.app, h.relay] as Array<{
    expectFrame: (...a: never[]) => Promise<unknown>
  }>) {
    const raw = target.expectFrame.bind(target) as (
      t: string,
      p?: unknown,
      o?: Record<string, unknown>,
    ) => Promise<unknown>
    target.expectFrame = ((t: string, p?: unknown, o?: Record<string, unknown>) =>
      raw(t, p, { timeoutMs: 10_000, ...o })) as never
  }
  const agent = new FakeAgent(h)
  const sh: SchedHarness = Object.assign(h, {
    clock,
    box,
    agent,
    async advance(ms: number, o: { catchUp?: boolean } = {}) {
      box.now = new Date(clock.now() + ms).toISOString()
      await advanceSteps(clock, ms, 40_000, h.bridge.client) // the relay's pong watchdog trips at 62 s of silence
      // The runner loop skips a timer that fires while its previous tick still runs, and a 40 s step fires ~150 timers in
      // under 2 s of real time. A tick that began before a slot and ended after the last step leaves no tick at the final
      // time, and the slot is never offered. So: let a running tick finish, then run one tick at exactly this time. The
      // clock is not moved. (The schedule queue is the service's own public seam; the product code is unchanged.)
      const svc = h.bridge.ctx.schedules
      if (svc?.armed && o.catchUp !== false) {
        await svc.idle()
        await svc.enqueue(() => svc.runnerTick())
        await svc.idle()
      }
    },
    noteKinds: () => h.notes.map((n) => n.meta.kind ?? ''),
    notesOf: (kind: string) => h.notes.filter((n) => n.meta.kind === kind),
  })
  return sh
}

/** Restarts the bridge half of a harness in place: same Chronos, same home (sidecar, ledger), a new instance id. */
export async function restartBridge(h: SchedHarness, instance = `bi_${newUlid().slice(-10)}`): Promise<SchedHarness> {
  await h.stop()
  const next = await startSched({
    box: h.box,
    home: h.home,
    now: new Date(h.clock.now()).toISOString(),
    instance,
  })
  return next
}

/**
 * Stands in for the Claude session on a `schedule_run` notification: the same steps S6.2 tells the real agent to take,
 * through the real tools. `subAgentPrompts` is what it would hand the Agent tool (standing rules first, then the job).
 */
export class FakeAgent {
  readonly subAgentPrompts: string[] = []
  readonly log: string[] = []
  constructor(private readonly h: Harness) {}

  /** The text after step 3 of a schedule_run notification: the guard (if any) then the job. */
  static subAgentPrompt(content: string): string {
    const i = content.indexOf('--- standing rules (guard) ---')
    const j = content.indexOf('--- job ---')
    if (i >= 0) return content.slice(i)
    return content.slice(j)
  }

  async start(runId: string) {
    const r = await this.h.bridge.callTool('schedule_run_start', { run_id: runId })
    this.log.push(`start:${r.content[0]?.text}`)
    return r.content[0]?.text ?? ''
  }

  async done(runId: string, ok: boolean, summary: string, report?: string) {
    const r = await this.h.bridge.callTool('schedule_run_done', {
      run_id: runId,
      ok,
      summary,
      ...(report !== undefined ? { report } : {}),
    })
    this.log.push(`done:${r.content[0]?.text}`)
    return r.content[0]?.text ?? ''
  }

  /** The whole happy path for one notification. Returns the tool answers. */
  async run(note: Notification, opts: { ok?: boolean; summary?: string; report?: string } = {}) {
    const runId = note.meta.run_id as string
    const started = await this.start(runId)
    if (!started.startsWith('GO')) return { started, done: '' }
    this.subAgentPrompts.push(FakeAgent.subAgentPrompt(note.content))
    const thread = note.meta.thread_id as string
    await this.h.bridge.callTool('reply', { thread_id: thread, text: opts.summary ?? 'Digest posted.' })
    const done = await this.done(runId, opts.ok ?? true, opts.summary ?? 'Digest posted.', opts.report)
    return { started, done }
  }
}

/** Waits until a `schedule_run` notification (optionally for one job) has arrived. */
export async function nextRun(h: SchedHarness, id?: string, ms = 8000): Promise<Notification> {
  let found: Notification | undefined
  await waitFor(
    () => {
      found = h.notes.find((n) => n.meta.kind === 'schedule_run' && (!id || n.meta.schedule_id === id))
      return Boolean(found)
    },
    ms,
    `a schedule_run notification for ${id ?? 'any job'} (have ${h.noteKinds().join(',')}; ${h.bridge.ctx.schedules?.discoveryNote() ?? 'no schedule service'})`,
  )
  return found as Notification
}

export const readSidecar = (h: Harness) => {
  try {
    return JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export { advanceSteps, sleep, tempHome, waitFor }

/** What a bridge that was killed leaves in its home (instances/<id>.json, a pid that is no longer running): its claims may be closed. */
export function leaveDeadInstance(home: string, instance: string) {
  const dir = join(home, 'instances')
  mkdirSync(dir, { recursive: true })
  const pid = Bun.spawnSync(['true']).pid // exited and reaped, so not running
  writeFileSync(
    join(dir, `${instance}.json`),
    JSON.stringify({ instance, pid, started_at: 'Mon Jan  1 00:00:00 2024' }),
  )
}
