// Answers `heartbeat.test` (docs/HEARTBEAT.md "In the app"). The request is checked and ACKED at once; the sources then really
// run, in dry mode, on their own runner (a slow test never holds up a real slot, and a real run never holds up a test), and the
// answer is sent as `heartbeat.test_result` when they are done. A test writes no store, posts nothing, wakes nobody.
//
// A pass is decided with the app's own reading of the result (`parseHeartbeatTestResult` + `heartbeatTestPassed`), and only then
// remembered (`recordPass`), so the bridge and the app cannot disagree about what passed.
import {
  type Frame,
  HEARTBEAT_TEST_MAX_WINDOW_H,
  HeartbeatConfig,
  type HeartbeatConfigT,
  heartbeatConfigHashOf,
  heartbeatTestPassed,
  parseHeartbeatTestResult,
} from '@talos-app/protocol'
import { errorFrame, heartbeatTestResultFrame, scheduleAckFrame } from '../frames-out.ts'
import type { SrcOut } from './run-parts.ts'
import type { HeartbeatRunner } from './runner.ts'
import { recordPass } from './tested.ts'

type TestFrame = Extract<Frame, { type: 'heartbeat.test' }>
/**
 * Tests running at once. A test spawns the owner's own commands, so a stuck sheet cannot pile them up; and one runner runs one
 * thing at a time, so a second test would only wait behind the first, perhaps past the 200 s the sheet waits.
 */
export const MAX_TESTS_AT_ONCE = 1
const LINES_MAX = 20
/** A rough figure from the design ("1 wake today, about 180K fresh tokens"), not a measurement. Replace it once a real wake has been measured. */
export const EST_TOKENS_PER_WAKE = 180_000

export type TesterDeps = {
  runner: HeartbeatRunner
  home: string
  now(): number
  send(frame: Frame): boolean
  log(msg: string, fields?: Record<string, unknown>): void
}

export class HeartbeatTester {
  private readonly running = new Map<string, { ac: AbortController; done: Promise<void> }>()
  constructor(private readonly d: TesterDeps) {}

  /** Stops every test and kills its sources. Nothing is sent for them (the bridge is going away). */
  abortAll() {
    for (const r of this.running.values()) r.ac.abort()
  }
  /** Resolves when the tests running now have answered (tests and shutdown). */
  async idle() {
    await Promise.all([...this.running.values()].map((r) => r.done))
  }

  private err(
    code: Parameters<typeof errorFrame>[1],
    message: string,
    ref: string,
    fields?: Array<{ path: string; message: string }>,
  ) {
    this.d.send(errorFrame(this.d.now(), code, message, ref, fields))
  }

  /** The frame is verified already. Never throws. Answers `ack{ref}` or `error{ref}` now, and the result later. */
  handle(f: TestFrame): void {
    const rid = f.request_id
    if (this.running.has(rid)) {
      this.d.send(scheduleAckFrame(this.d.now(), f.id)) // the same test asked twice (a retry): it is already running
      return
    }
    if (f.with_agent) {
      this.err('scheduler_unavailable', "Testing with the agent isn't available yet.", f.id)
      return
    }
    if (f.window_h > HEARTBEAT_TEST_MAX_WINDOW_H) {
      this.err('schedule_invalid', 'That look-back is too long.', f.id)
      return
    }
    const parsed = HeartbeatConfig.safeParse(f.config)
    if (!parsed.success) {
      const fields = parsed.error.issues
        .slice(0, 20)
        .map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message }))
      const first = fields[0]
      this.err(
        'schedule_invalid',
        `These heartbeat settings can't be tested${first ? ` (${first.path}: ${first.message})` : ''}. Nothing was run.`,
        f.id,
        fields,
      )
      return
    }
    if (this.running.size >= MAX_TESTS_AT_ONCE) {
      this.err('rate_limited', 'A heartbeat test is already running. Wait for it to finish, then try again.', f.id)
      return
    }
    this.d.send(scheduleAckFrame(this.d.now(), f.id))
    const ac = new AbortController()
    const done = this.run(f, parsed.data, ac).finally(() => this.running.delete(rid))
    this.running.set(rid, { ac, done })
  }

  private async run(f: TestFrame, config: HeartbeatConfigT, ac: AbortController): Promise<void> {
    const { d } = this
    const answered = new Map<string, SrcOut>()
    let result: Record<string, unknown>
    try {
      const out = await d.runner.run({
        jobId: '(test)',
        jobName: 'Heartbeat test',
        runKey: new Date(d.now()).toISOString().slice(0, 10),
        config: { config, skipped: 0 },
        trigger: 'run_now',
        test: { windowH: f.window_h, onSource: (o) => answered.set(o.id, o) },
        signal: ac.signal,
      })
      if (out.aborted || ac.signal.aborted) return
      const detail = out.test
      if (!detail) throw new Error('the runner gave no test detail')
      const hash = heartbeatConfigHashOf(f.config)
      const sources = out.result.sources.map((s) => {
        const c = detail.sources.find((x) => x.id === s.id)
        return {
          id: s.id,
          ok: s.ok,
          ms: s.ms,
          read: c?.read ?? 0,
          act: c?.act ?? 0,
          fyi: c?.fyi ?? 0,
          dropped: c?.dropped ?? 0,
          held: c?.held ?? 0,
          unreadable: s.unreadable,
          ...(s.error !== undefined ? { error: s.error } : {}),
        }
      })
      // What the checks found, and what live mode would do with it. In shadow mode the heartbeat only records, so the answer
      // says nothing would wake or post, and keeps the live picture apart as "if live".
      const wakes = detail.would_wake.length > 0 ? 1 : 0
      const live = {
        would_wake: detail.would_wake.slice(0, LINES_MAX),
        would_post: detail.would_post.slice(0, LINES_MAX),
        est_wakes: wakes,
        est_tokens: wakes * EST_TOKENS_PER_WAKE,
      }
      const shadow = config.mode === 'shadow'
      result = {
        config_hash: hash,
        at: new Date(d.now()).toISOString(),
        window_h: f.window_h,
        with_agent: false,
        mode: config.mode,
        sources,
        would_wake: shadow ? [] : live.would_wake,
        would_post: shadow ? [] : live.would_post,
        held: detail.held,
        est_wakes: shadow ? 0 : live.est_wakes,
        est_tokens: shadow ? 0 : live.est_tokens,
        if_live: shadow ? live : null,
        error: null,
      }
      // Decided the way the app will decide it. A pass that cannot be remembered is not a pass: the owner would press Turn on
      // and be refused, so the sheet is told the truth now.
      const read = parseHeartbeatTestResult(result)
      if (read.ok && heartbeatTestPassed(read.result, config, d.now())) {
        try {
          recordPass(d.home, hash, d.now())
        } catch (e) {
          d.log('heartbeat test pass not saved', { error: (e as Error).message })
          result = {
            ...result,
            error: 'The test passed, but this Mac could not save it. Check the disk, then test again.',
          }
        }
      }
    } catch (e) {
      d.log('heartbeat test failed', { error: (e as Error).message })
      result = this.broke(f, config, answered)
    }
    try {
      if (!d.send(heartbeatTestResultFrame(d.now(), f.request_id, result)))
        d.log('heartbeat test result not sent (no relay connection)', {})
    } catch (e) {
      d.log('heartbeat test result not sent', { error: (e as Error).message })
    }
  }

  /**
   * The run broke after the ack. Sources that had answered keep their real result (counts are what they returned, before any
   * mute or gate); the others are marked failed. `error` says the run broke, so this is never a pass.
   */
  private broke(f: TestFrame, config: HeartbeatConfigT, answered: Map<string, SrcOut>): Record<string, unknown> {
    const sources = config.sources
      .filter((s) => s.enabled)
      .map((s) => {
        const o = answered.get(s.id)
        if (!o)
          return {
            id: s.id,
            ok: false,
            ms: 0,
            read: 0,
            act: 0,
            fyi: 0,
            dropped: 0,
            held: 0,
            unreadable: 0,
            error: 'It did not finish.',
          }
        const level = (l: string) => o.items.filter((i) => i.level === l).length
        return {
          id: s.id,
          ok: o.ok,
          ms: Math.min(o.ms, 150_000),
          read: o.items.length,
          act: level('act'),
          fyi: level('fyi'),
          dropped: 0,
          held: 0,
          unreadable: o.unreadable,
          ...(o.error !== undefined ? { error: o.error } : {}),
        }
      })
    return {
      config_hash: heartbeatConfigHashOf(f.config),
      at: new Date(this.d.now()).toISOString(),
      window_h: f.window_h,
      with_agent: false,
      mode: config.mode,
      sources,
      would_wake: [],
      would_post: [],
      held: 0,
      est_wakes: null,
      est_tokens: null,
      if_live: null,
      error: 'The test could not finish. Try again.',
    }
  }
}
