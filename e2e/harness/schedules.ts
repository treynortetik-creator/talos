// The Mac's scheduler for the Schedules e2e suite (docs/SCHEDULES.md S9, WP-S4): the REAL vendored Chronos CLI
// (third_party/chronos, v0.3.0) in a temp HOME, reached by the real bridge through TALOS_APP_CHRONOS_BIN. The only fakes
// are the ones Chronos ships for its own tests (tests/fake-claude.sh for headless runs, tests/fake-launchctl.sh) and
// Chronos's clock: the wrapper reads CHRONOS_NOW from a file the test moves, so "the fire time passes" is one write and
// every due/claim/missed decision is still Chronos's own. The bridge, relay and browser share one running clock
// (signatures, freshness and sessions are real): the wall clock, or the instant E2E_NOW starts it from (harness/clock.ts).
// Nothing in the bridge is given TALOS_APP_CHRONOS_NOW.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext } from '@playwright/test'
import type { ChronosDraftT } from '@talos-app/protocol'
import { CHRONOS_SRC, ChronosBox, draft, TZ } from '../../apps/bridge/test/schedules/chronos-box.ts'
import { realNow } from './clock.ts'

export { draft, realNow, TZ }

const PYTHON = (() => {
  const r = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' })
  return r.stdout.trim() || 'python3'
})()

/** `2026-10-05T11:04:00.000Z` → `07:04` in the scheduler's zone. */
export function localHHMM(iso: string, tz = TZ): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

const minuteOfDay = (iso: string): number => {
  const [h, m] = localHHMM(iso).split(':').map(Number) as [number, number]
  return h * 60 + m
}

/** The instant `hhmm` falls on `iso`'s local day. A local day is not always 24 hours, so this checks where it landed. */
export function atLocal(iso: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  let t = Date.parse(iso)
  for (let i = 0; i < 3; i++) t += (h * 60 + m - minuteOfDay(new Date(t).toISOString())) * 60_000
  return new Date(t).toISOString()
}

/** How far the longest scenario reaches past the start: a job 2 h ahead plus a few minutes. */
const LONGEST_SPAN_MIN = 130
/** How far before the start a scenario reaches: a job whose time passed an hour ago. */
const REACH_BACK_MIN = 60

const utcOffsetLabel = (ms: number): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).format(ms)

/**
 * Where a scenario starts: the real minute (or E2E_NOW), or local noon of that day when the scenario would not fit.
 *
 * A scenario's daily jobs sit up to two hours after the start and an hour before it, and they mean what they say only on
 * one plain local day: Chronos reads a daily "00:05" as already past once the clock is on the day, and "01:30" as the
 * first of two on the morning the clocks go back. So a span that crosses local midnight or a clock change moves to local
 * noon, which neither ever reaches. The whole stack starts there (the `worldAt` fixture), not just Chronos: moved alone,
 * a browser hours ahead of the bridge sees every card as already expired.
 */
export function chronosStart(): string {
  const t = Math.floor(realNow() / 60_000) * 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const [from, to] = [t - REACH_BACK_MIN * 60_000, t + LONGEST_SPAN_MIN * 60_000]
  const oneDay = localNaive(iso(from)).slice(0, 10) === localNaive(iso(to)).slice(0, 10)
  const oneOffset = utcOffsetLabel(from) === utcOffsetLabel(to)
  return oneDay && oneOffset ? iso(t) : atLocal(iso(t), '12:00')
}

/**
 * Pins the browser's clock to `iso` (it keeps ticking from there). The page's "has this run time passed" decisions use
 * the browser clock, so a test about them states the instant instead of trusting the wall clock. A signed frame still
 * lands in the Mac's window: the app corrects its stamps by the relay's clock (socketClient `clockOffset`).
 */
export async function pinBrowserClock(context: BrowserContext, iso: string): Promise<void> {
  const time = new Date(iso)
  try {
    await context.clock.install({ time })
  } catch {
    // already installed (the fixture pinned it): move it
    await Promise.all(context.pages().map((p) => p.clock.setSystemTime(time)))
  }
}

/** `2026-10-05T11:04:00.000Z` → `2026-10-05T07:04:00` in the scheduler's zone. */
export function localNaive(iso: string, tz = TZ): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

export const plusMin = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString()

export class ChronosMac extends ChronosBox {
  readonly nowFile: string

  constructor(now: string, opts: { sessionRunner?: 'talos' | 'hook'; approvalRequired?: boolean } = {}) {
    super(now)
    this.nowFile = join(this.dir, 'now')
    writeFileSync(this.nowFile, now)
    // ChronosBox's wrapper, plus: Chronos's clock comes from the now file unless a caller passes CHRONOS_NOW itself.
    writeFileSync(
      this.bin,
      [
        '#!/bin/sh',
        `export HOME='${this.home}' TZ='${TZ}' CHRONOS_TEST_MODE=1 PYTHONDONTWRITEBYTECODE=1 FAKE_LAUNCHCTL_DIR='${this.dir}/launchctl' CHRONOS_LAUNCHCTL='${join(CHRONOS_SRC, 'tests', 'fake-launchctl.sh')}'`,
        'unset CHRONOS_CONFIG',
        `[ -n "\${CHRONOS_NOW:-}" ] || CHRONOS_NOW="$(cat '${this.nowFile}')"`,
        'export CHRONOS_NOW',
        `exec '${PYTHON}' '${join(CHRONOS_SRC, 'bin', 'chronos')}' "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(this.bin, 0o755)
    this.configure({ sessionRunner: opts.sessionRunner ?? 'talos', approvalRequired: opts.approvalRequired ?? true })
  }

  /** Moves Chronos's clock (the bridge, relay and browser keep theirs). */
  setNow(iso: string) {
    this.now = iso
    writeFileSync(this.nowFile, iso)
  }

  /** A job written the way the bridge writes an approved card (validate + apply), so it is approved and runnable. */
  add(over: Partial<ChronosDraftT> = {}): ChronosDraftT {
    const d = draft(over)
    this.create(d)
    return d
  }

  /** Chronos config keys (config.json), merged. */
  setConfig(patch: Record<string, unknown>) {
    const file = join(this.home, '.config', 'chronos', 'config.json')
    const cur = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
    writeFileSync(file, JSON.stringify({ ...cur, ...patch }, null, 2))
  }

  /**
   * One launchd tick (`bin/chronos-tick.sh`), as the watchman runs it every 5 minutes, at Chronos's current clock.
   * `fakeMode` is Chronos's fake claude's mode for any headless run it spawns (`hang` = a launch stall).
   */
  tick(fakeMode = 'ok'): void {
    const r = spawnSync('/bin/bash', [join(CHRONOS_SRC, 'bin', 'chronos-tick.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${PYTHON.replace(/\/python3$/, '')}:/usr/bin:/bin`,
        HOME: this.home,
        TZ,
        CHRONOS_TEST_MODE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        // the form launchd's tick sees in real life (`date +%Y-%m-%dT%H:%M:%S`, local), not an ISO instant
        CHRONOS_NOW: localNaive(this.now),
        FAKE_MODE: fakeMode,
        CHRONOS_POLL_S: '1', // the launch watchdog's poll (Chronos's own test knob)
        FAKE_LAUNCHCTL_DIR: join(this.dir, 'launchctl'),
        CHRONOS_LAUNCHCTL: join(CHRONOS_SRC, 'tests', 'fake-launchctl.sh'),
      },
    })
    if (r.status !== 0) throw new Error(`chronos tick failed: ${r.stdout} ${r.stderr}`)
  }

  /** What `chronos api snapshot` says about one job (the scheduler's own view, not the bridge's). */
  job(id: string): Record<string, unknown> | undefined {
    const s = this.api<{ schedules: Array<Record<string, unknown>> }>(['snapshot'])
    return s.schedules.find((j) => j.id === id)
  }

  /** Everything the bridge needs to use this Chronos. */
  bridgeEnv(): Record<string, string> {
    return { TALOS_APP_CHRONOS_BIN: this.bin }
  }

  logs(): string {
    try {
      return readFileSync(join(this.home, '.chronos', 'logs', 'chronos.log'), 'utf8')
    } catch {
      return ''
    }
  }
}
