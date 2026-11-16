// scripts/heavy-lock.sh: the one heavy-work lock per machine. It is ci-local's suites mutex (locks/mutex-suites), so CI's suites,
// the gate's suites, the Swift suites, stress loops and evals all queue on it: first come, first served, a holder that dies frees
// it, a nested call from inside a holder passes straight through, and a guard can hold a job back before it starts.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { timeFactor } from '../packages/testkit/src/time-factor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const HL = join(here, 'heavy-lock.sh')
// every budget here is a hang cap, never what a test proves: x TALOS_TEST_TIME_FACTOR (scripts/gate.sh; 1 by default); a
// HEAVY_LOCK_TIMEOUT of 1 or 2 stays as written: the test expects it to run out, or expects no wait at all
const F = timeFactor()
const secs = (s: number) => String(s * F)
vi.setConfig({ testTimeout: 60_000 * F })
const dirs: string[] = []
const kids: ChildProcess[] = []
// TERM first: heavy-lock.sh's trap then stops its command's own process group, which a KILL of the wrapper alone would leave
// running (a holder from a failed test, waiting for its go file for good)
afterEach(async () => {
  const live = kids.splice(0).filter((k) => k.pid && k.exitCode === null)
  for (const k of live) spawnSync('kill', ['-TERM', String(k.pid)])
  // until each has exited (its trap has stopped its command), however slow the machine; KILL only what is left after that
  await Promise.all(live.map((k) => (k.exitCode === null ? exited(k, 5_000 * F) : null)))
  for (const k of live) if (k.exitCode === null) spawnSync('kill', ['-KILL', String(k.pid)])
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  dirs.push(d)
  return d
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// a child's exit, or false once ms have gone by without one
const exited = (c: ChildProcess, ms: number) =>
  new Promise<boolean>((r) => {
    if (c.exitCode !== null || c.signalCode !== null) return r(true)
    const timer = setTimeout(() => r(false), ms)
    c.once('exit', () => {
      clearTimeout(timer)
      r(true)
    })
  })
const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
// A pid's start time in this machine's own form, from the lock code itself (ci_proc_start): a /proc token on Linux
// (linux:<boot id>:<start>), ps text elsewhere. A fake start must be in the same form, or the lock rightly can't compare it.
const LOCKS_SH = join(here, 'ci-local/locks.sh')
const procStart = (pid: number) =>
  spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start ${pid}`], { encoding: 'utf8' }).stdout.trim()
// the same form, another value: what a reused pid looks like
const otherStart = (start: string) =>
  start.startsWith('linux:') ? start.replace(/:(\d+)$/, (_, n) => `:${Number(n) + 1}`) : 'Thu Jan  1 00:00:00 1970'

function machine() {
  const cache = tmp()
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: cache,
    TALOS_CI_CACHE: cache,
    HEAVY_LOCK_POLL: '0.1',
    TALOS_HEAVY_GUARD: join(cache, 'no-guard'),
  }
  const lock = join(cache, 'locks', 'mutex-suites')
  const queue = join(cache, 'locks.queue', 'suites')
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [HL, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 * F })
  // a holder in the background: its command waits for <cache>/<tag>.go, and writes <tag>.ran when it starts
  const hold = (tag: string, extra: Record<string, string> = {}) => {
    const out: string[] = []
    const c = spawn(
      'bash',
      [
        HL,
        'run',
        tag,
        '--',
        'sh',
        '-c',
        `echo "$$" > "${cache}/${tag}.ran"; while [ ! -f "${cache}/${tag}.go" ]; do sleep 0.05; done`,
      ],
      { env: { ...env, ...extra } },
    )
    kids.push(c)
    c.stderr?.on('data', (d) => out.push(String(d)))
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    return { c, done, err: () => out.join(''), go: () => writeFileSync(join(cache, `${tag}.go`), '') }
  }
  const ran = (tag: string) => existsSync(join(cache, `${tag}.ran`))
  const until = async (f: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms * F
    while (!f()) {
      if (Date.now() > end) throw new Error('timed out')
      await sleep(50)
    }
  }
  const tickets = () => (existsSync(queue) ? readdirSync(queue) : [])
  // a holder's run record names its command's process group: what a waiter that takes over from a dead holder stops. The holder
  // writes it just after starting the command, so the command (and its <tag>.ran) can be there first.
  const runs = join(cache, 'runs')
  const recorded = (pid: number) =>
    existsSync(runs) &&
    readdirSync(runs).some((n) => {
      const f = join(runs, n, 'groups')
      return existsSync(f) && readFileSync(f, 'utf8').startsWith(`${pid} `)
    })
  return { cache, env, lock, queue, run, hold, ran, until, tickets, recorded }
}

// until a waiter has waited a whole second by the clock the lock code logs with (date +%s): it says it waits only after it noted
// when it asked, so a second boundary passed after that line is a second of waiting, however slow the machine
async function oneSecondPast(m: ReturnType<typeof machine>, w: { err: () => string }) {
  await m.until(() => w.err().includes('waiting for the heavy lock'))
  const seen = Math.floor(Date.now() / 1000)
  await m.until(() => Math.floor(Date.now() / 1000) >= seen + 1)
}

describe('heavy-lock.sh run: one holder at a time, first come first served', () => {
  it('runs the command under the lock, passes its output and exit code, and leaves nothing behind', () => {
    const m = machine()
    const r = m.run(['run', 'probe', '--', 'sh', '-c', 'echo out; exit 3'])
    expect(r.status).toBe(3)
    expect(r.stdout).toBe('out\n')
    expect(existsSync(m.lock)).toBe(false)
    expect(m.tickets()).toEqual([])
    expect(m.run(['status']).stdout).toContain('free')
  })

  it('status names the holder: its pid, what it runs and since when', async () => {
    const m = machine()
    const a = m.hold('stress-a')
    await m.until(() => m.ran('stress-a'))
    const s = m.run(['status']).stdout
    expect(s).toMatch(new RegExp(`held by pid ${a.c.pid} \\(stress-a: sh -c .*, since \\d\\d:\\d\\d:\\d\\d\\)`))
    a.go()
    expect(await a.done).toBe(0)
  })

  it('waiters go in the order they came, and each says whom it waits for', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const b = m.hold('b')
    await m.until(() => m.tickets().length === 1)
    const c = m.hold('c')
    await m.until(() => m.tickets().length === 2)
    await m.until(() => b.err().includes('held by pid'))
    expect(b.err()).toMatch(
      new RegExp(`waiting for the heavy lock, held by pid ${a.c.pid} \\(a: sh -c .*, since \\d\\d:\\d\\d:\\d\\d\\)`),
    )
    await m.until(() => c.err().includes('1 ahead'))
    a.go()
    await m.until(() => m.ran('b'))
    expect(m.ran('c')).toBe(false) // b was first in line, so c still waits
    b.go()
    await m.until(() => m.ran('c'))
    c.go()
    expect([await a.done, await b.done, await c.done]).toEqual([0, 0, 0])
  })

  it('many at once: every one runs, one at a time, none fails on another\u2019s queue housekeeping', async () => {
    const m = machine()
    writeFileSync(join(m.cache, 'count'), '0\n')
    const body = `mkdir "${m.cache}/inside" || echo overlap >> "${m.cache}/overlap"; n=$(cat "${m.cache}/count"); echo $((n + 1)) > "${m.cache}/count"; rmdir "${m.cache}/inside"`
    const runs = Array.from({ length: 12 }, (_, i) => {
      const c = spawn('bash', [HL, 'run', `many-${i}`, '--', 'sh', '-c', body], {
        env: { ...m.env, HEAVY_LOCK_TIMEOUT: secs(60) },
      })
      kids.push(c)
      return new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    })
    expect(await Promise.all(runs)).toEqual(Array(12).fill(0))
    expect(readFileSync(join(m.cache, 'count'), 'utf8').trim()).toBe('12')
    expect(existsSync(join(m.cache, 'overlap'))).toBe(false)
  })

  it('a waiter stopped with TERM takes its ticket with it', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const b = m.hold('b')
    // a waiter: its ticket is whole (not a .part still being written) and it has looked at the lock and said whom it waits for
    await m.until(
      () => m.tickets().length === 1 && !m.tickets()[0].endsWith('.part') && b.err().includes('held by pid'),
    )
    process.kill(b.c.pid as number, 'SIGTERM')
    // bounded, so a waiter that does not go says where it is instead of using up the test's whole budget
    const ps = () =>
      spawnSync('ps', ['-o', 'pid,ppid,stat,command', '-g', String(b.c.pid)], { encoding: 'utf8' }).stdout
    expect(await exited(b.c, 20_000 * F), `TERM did not end the waiter\n${b.err()}\n${ps()}`).toBe(true)
    expect(b.c.exitCode).toBe(143)
    expect(m.tickets()).toEqual([])
    a.go()
    expect(await exited(a.c, 20_000 * F), a.err()).toBe(true)
    expect(await a.done).toBe(0)
  })

  it('a waiter gives up after HEAVY_LOCK_TIMEOUT with an error, and takes its ticket with it', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const r = m.run(['run', 'late', '--', 'true'], { HEAVY_LOCK_TIMEOUT: '1' })
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('timed out waiting for the heavy lock')
    expect(m.tickets()).toEqual([])
    a.go()
    await a.done
  })
})

// On the CI Mac, CI's suites (a ci-local slot's ticket, kind "ci") are served before push gates, builder gates and other
// heavy-lock.sh runs, first come first served within each; a holder is never stopped for anyone. Only a jump (a checked red-main
// gate) goes before CI. How long a gate waits is bounded by CI's own arrivals: gates that
// wait push nothing, so they trigger no more CI, and the oldest goes once CI already queued is done (the 'by kind' tests below).
describe('heavy lock queue order: CI first, then gates, and no gate waits forever', () => {
  // a ci-local slot's waiter: ci_mutex as ci-local calls it (no CI_MUTEX_WHAT, so its ticket says "slot N")
  // old: the waiting rule main had before CI went first (plain first come first served), as a machine still runs it
  // mid-changeover, or a branch's gate whose lock code differs from CI's
  const OLD_FIFO =
    'ci_first_in_line() { local t who; for t in "$1"/*; do case "$t" in *.part) continue ;; esac; [ -f "$t" ] || continue; ' +
    '[ "$t" = "$2" ] && return 0; who="$(sed -n 1,3p "$t" 2>/dev/null)"; [ -n "$who" ] && ci_owner_alive "$who" && return 1; ' +
    'rm -f "$t"; done; return 0; }; '
  const ciWaiter = (m: ReturnType<typeof machine>, tag: string, extra: Record<string, string> = {}, old = false) => {
    const c = spawn(
      'bash',
      [
        '-c',
        `CI_NONCE=ci-${tag}-$$; CI_HELD=; CI_MARKER=; CI_POLL=0.1; CI_LOCK_TIMEOUT=${secs(60)}; CI_LOCK_GRACE=30; CI_SLOT=\${CI_SLOT:-1}; RUN_DIR=; ` +
          `. "${LOCKS_SH}"; ${old ? OLD_FIFO : ''}ci_mutex "${m.cache}/locks" suites sh -c 'echo $$ > "${m.cache}/${tag}.ran"; while [ ! -f "${m.cache}/${tag}.go" ] && kill -0 $PPID 2>/dev/null; do sleep 0.05; done'`, // ends with its waiter
      ],
      { env: { ...m.env, ...extra } },
    )
    kids.push(c)
    let err = ''
    c.stderr?.on('data', (d) => {
      err += d
    })
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    return { c, done, err: () => err, go: () => writeFileSync(join(m.cache, `${tag}.go`), '') }
  }

  it('a CI suite that asked after a gate is served before it; a gate holding the lock is never stopped for CI', async () => {
    const m = machine()
    const a = m.hold('gate-a') // a gate holds the lock
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b') // a gate waits
    await m.until(() => m.tickets().length === 1)
    const c = ciWaiter(m, 'ci-c') // then CI asks
    await m.until(() => m.tickets().length === 2)
    await m.until(() => c.err().includes('waiting for the heavy lock')) // it has looked, and waits
    expect(m.ran('ci-c')).toBe(false) // not before the holder is done
    a.go()
    await m.until(() => m.ran('ci-c'))
    expect(m.ran('gate-b')).toBe(false) // CI went first
    c.go()
    await m.until(() => m.ran('gate-b'))
    b.go()
    expect([await a.done, await b.done, await c.done]).toEqual([0, 0, 0])
  })

  it('mixed lock code: a gate (new order) ahead of an old-code CI waiter (first come first served) is not stuck', async () => {
    // the 13:05 deadlock: the gate deferred to CI's ticket behind it, while that CI waiter, on main's old code, waited for the
    // gate ahead of it; the lock sat free with both waiting. A waiter that defers takes a lock left free CI_DEFER_GRACE seconds.
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b', { CI_DEFER_GRACE: '1' })
    await m.until(() => m.tickets().length === 1)
    const c = ciWaiter(m, 'ci-c', {}, true)
    await m.until(() => m.tickets().length === 2)
    a.go()
    await m.until(() => m.ran('gate-b'), 10_000)
    expect(m.ran('ci-c')).toBe(false)
    b.go()
    await m.until(() => m.ran('ci-c'), 10_000)
    c.go()
    expect([await a.done, await b.done, await c.done]).toEqual([0, 0, 0])
  })

  it('mixed lock code: an old-code CI waiter ahead of a new-code one, and a new-code gate behind both, all get it', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b', { CI_DEFER_GRACE: '1' })
    await m.until(() => m.tickets().length === 1)
    const c = ciWaiter(m, 'ci-old', {}, true)
    await m.until(() => m.tickets().length === 2)
    const d = ciWaiter(m, 'ci-new', { CI_DEFER_GRACE: '1' })
    await m.until(() => m.tickets().length === 3)
    a.go()
    const order: string[] = []
    const tags = ['gate-b', 'ci-old', 'ci-new']
    const gos: Record<string, () => void> = { 'gate-b': b.go, 'ci-old': c.go, 'ci-new': d.go }
    while (order.length < 3) {
      await m.until(() => tags.some((t) => !order.includes(t) && m.ran(t)), 10_000)
      const t = tags.find((x) => !order.includes(x) && m.ran(x))!
      order.push(t)
      gos[t]()
    }
    expect(order.sort()).toEqual([...tags].sort())
    expect([await a.done, await b.done, await c.done, await d.done]).toEqual([0, 0, 0, 0])
  })

  // the 2026-11-15 stall: push gates that had waited past the old cap (CI_GATE_MAX_WAIT, 30 min) went before CI, one after
  // another, and main had no verdict for 2 h. Two push gates past any cap, then CI asks: CI goes first; the knob is gone.
  it('a CI slot arriving after two gates gets the lock before them, however long they waited', async () => {
    const m = machine()
    const live = () => m.tickets().filter((t) => !t.endsWith('.part')).length
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b', { CI_GATE_MAX_WAIT: '1', HEAVY_LOCK_PUSH: '1' })
    await m.until(() => live() === 1)
    const d = m.hold('gate-d', { CI_GATE_MAX_WAIT: '1', HEAVY_LOCK_PUSH: '1' })
    await m.until(() => live() === 2)
    await oneSecondPast(m, d) // both gates have now waited past a 1 s cap
    const c = ciWaiter(m, 'ci-c', { CI_GATE_MAX_WAIT: '1' })
    await m.until(() => live() === 3)
    await m.until(() => c.err().includes('waiting for the heavy lock'))
    a.go()
    await m.until(() => m.ran('ci-c'))
    expect(m.ran('gate-b') || m.ran('gate-d')).toBe(false)
    c.go()
    await m.until(() => m.ran('gate-b')) // then the gates, in the order they came
    expect(m.ran('gate-d')).toBe(false)
    b.go()
    await m.until(() => m.ran('gate-d'))
    d.go()
    expect([await a.done, await b.done, await c.done, await d.done]).toEqual([0, 0, 0, 0])
  })

  it('a red-main gate (push, jump) still beats a waiting CI slot; the holder is not stopped', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const c = ciWaiter(m, 'ci-c')
    await m.until(() => m.tickets().length === 1)
    const r = m.hold('red', { HEAVY_LOCK_PUSH: '1', HEAVY_LOCK_JUMP: '1' }) // what gate-push.sh passes a checked --red-main gate
    await m.until(() => r.err().includes('waiting for the heavy lock'))
    expect(m.ran('red')).toBe(false)
    a.go()
    await m.until(() => m.ran('red'))
    expect(m.ran('ci-c')).toBe(false)
    r.go()
    await m.until(() => m.ran('ci-c'))
    c.go()
    expect([await a.done, await r.done, await c.done]).toEqual([0, 0, 0])
  })

  it('two CI slots keep their order among themselves, both ahead of a gate that came first', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const g = m.hold('gate-g', { HEAVY_LOCK_PUSH: '1' })
    await m.until(() => m.tickets().length === 1)
    const s2 = ciWaiter(m, 'slot-2', { CI_SLOT: '2' }) // slot 2 asked first
    await m.until(() => m.tickets().length === 2)
    const s1 = ciWaiter(m, 'slot-1', { CI_SLOT: '1' })
    await m.until(() => s1.err().includes('1 ahead'))
    a.go()
    await m.until(() => m.ran('slot-2'))
    expect(m.ran('slot-1') || m.ran('gate-g')).toBe(false)
    s2.go()
    await m.until(() => m.ran('slot-1'))
    expect(m.ran('gate-g')).toBe(false)
    s1.go()
    await m.until(() => m.ran('gate-g'))
    g.go()
    expect([await a.done, await g.done, await s1.done, await s2.done]).toEqual([0, 0, 0, 0])
  })

  // The bound: CI comes once per push to main (and the nightly), and a push needs a gate. So a gate waits behind CI only while
  // CI keeps arriving; once no CI waits, the gate is next. Here CI arrives three times while the gate waits, then stops.
  it('a gate is not starved: CI that keeps arriving goes first, and the gate goes as soon as none waits', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const g = m.hold('gate-g', { HEAVY_LOCK_PUSH: '1' })
    await m.until(() => m.tickets().length === 1)
    let holder: { go: () => void; done: Promise<number | null> } = a
    for (const tag of ['ci-1', 'ci-2', 'ci-3']) {
      const c = ciWaiter(m, tag) // CI asks while the lock is held and the gate waits
      await m.until(() => c.err().includes('waiting for the heavy lock'))
      holder.go()
      await m.until(() => m.ran(tag))
      expect(m.ran('gate-g')).toBe(false)
      expect(await holder.done).toBe(0)
      holder = c
    }
    holder.go() // no CI waits now
    await m.until(() => m.ran('gate-g'))
    g.go()
    expect([await holder.done, await g.done]).toEqual([0, 0])
  })

  it('status lists the waiters in the order they go, with each one’s kind', async () => {
    const m = machine()
    const live = () => m.tickets().filter((t) => !t.endsWith('.part')).length
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b', { HEAVY_LOCK_PUSH: '1' })
    await m.until(() => live() === 1)
    const r = m.hold('builder')
    await m.until(() => live() === 2)
    const c = ciWaiter(m, 'ci-c')
    await m.until(() => live() === 3)
    const j = m.hold('red', { HEAVY_LOCK_PUSH: '1', HEAVY_LOCK_JUMP: '1' })
    await m.until(() => live() === 4)
    const lines = m
      .run(['status'])
      .stdout.split('\n')
      .filter((l) => l.startsWith('  waiting'))
    expect(lines.map((l) => l.replace(/pid \d+/, 'pid N').replace(/: sh -c [^)]*/, ''))).toEqual([
      '  waiting 1: pid N (red), jump',
      '  waiting 2: pid N (slot 1), ci',
      '  waiting 3: pid N (gate-b), push',
      '  waiting 4: pid N (builder), run',
    ])
    const steps: [{ go: () => void }, string][] = [
      [a, 'red'],
      [j, 'ci-c'],
      [c, 'gate-b'],
      [b, 'builder'],
    ]
    for (const [w, next] of steps) {
      w.go()
      await m.until(() => m.ran(next))
    }
    r.go()
    expect([await a.done, await j.done, await c.done, await b.done, await r.done]).toEqual([0, 0, 0, 0, 0])
  })

  it('every wait is written down: logs/lock-waits.tsv has who waited and for how long', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const b = m.hold('gate-b')
    await m.until(() => m.tickets().length === 1)
    await oneSecondPast(m, b)
    a.go()
    await m.until(() => m.ran('gate-b'))
    b.go()
    await b.done
    const rows = readFileSync(join(m.cache, 'logs', 'lock-waits.tsv'), 'utf8')
      .trim()
      .split('\n')
    const row = rows.find((l) => l.includes('gate-b'))?.split('\t') ?? []
    expect(row[1]).toBe('suites')
    expect(row[2]).toMatch(/^gate-b: /)
    expect(Number(row[3])).toBeGreaterThanOrEqual(1)
  })

  it('a wait that times out is written down too, and a tab in the command cannot split the row', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const r = m.run(['run', 'late', '--', 'echo', 'x\ty'], { HEAVY_LOCK_TIMEOUT: '1' })
    expect(r.status).toBe(75)
    a.go()
    await a.done
    const row =
      readFileSync(join(m.cache, 'logs', 'lock-waits.tsv'), 'utf8')
        .trim()
        .split('\n')
        .find((l) => l.includes('late'))
        ?.split('\t') ?? []
    expect(row).toHaveLength(6)
    expect(row[2]).toBe('late: echo x y')
    expect(Number(row[3])).toBeGreaterThanOrEqual(1)
    expect(row[4]).toBe('timed out')
    expect(row[5]).toBe('run')
  })
})

describe('heavy-lock.sh: a holder that dies frees the lock', () => {
  const fake = (m: ReturnType<typeof machine>, pid: number, start: string) => {
    mkdirSync(m.lock, { recursive: true })
    writeFileSync(join(m.lock, 'owner'), `${pid}\n${start}\nnonce-x\n`)
    writeFileSync(join(m.lock, 'what'), 'a run that is gone\n')
  }

  it('a dead pid, or a live pid with another start time (reused), is taken over', () => {
    for (const reused of [false, true]) {
      const m = machine()
      const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim() // that pid has exited
      if (reused) fake(m, process.pid, otherStart(procStart(process.pid)))
      else fake(m, Number(gone), 'Thu Jan  1 00:00:00 1970')
      const r = m.run(['run', 'next', '--', 'echo', 'ran'], { HEAVY_LOCK_TIMEOUT: secs(10) })
      expect(r.status, `reused=${reused}: ${r.stderr}`).toBe(0)
      expect(r.stdout).toBe('ran\n')
    }
  })

  // Linux's /proc tokens, tested on any machine: ci_proc_start stood in for, ci_owner_alive real
  it('with /proc start tokens (Linux): same start is alive, another start (reused) or no process is not, ps text proves nothing', () => {
    const owner = (pid: number, start: string) => `${pid}\n${start}\nn`
    const check = (o: string) =>
      spawnSync(
        'bash',
        ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start() { echo linux:b00t:4242; }; ci_owner_alive "$1"`, '_', o],
        { encoding: 'utf8' },
      ).status
    const gone = Number(spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim())
    expect(check(owner(process.pid, 'linux:b00t:4242'))).toBe(0)
    expect(check(owner(process.pid, otherStart('linux:b00t:4242')))).toBe(1) // reused: taken over
    expect(otherStart('linux:b00t:4242')).toBe('linux:b00t:4243')
    expect(check(owner(gone, 'linux:b00t:4242'))).toBe(1)
    expect(check(owner(process.pid, 'Thu Jan  1 00:00:00 1970'))).toBe(0) // not comparable: never a takeover on its word
  })

  it('a live holder with its own start time is not taken over', () => {
    const m = machine()
    const start = procStart(process.pid)
    expect(start).not.toBe('') // an empty start would make this pass for the wrong reason
    fake(m, process.pid, start)
    const r = m.run(['run', 'next', '--', 'echo', 'ran'], { HEAVY_LOCK_TIMEOUT: '1' })
    expect(r.status).toBe(75)
    expect(r.stdout).toBe('')
  })

  it('a holder killed with SIGKILL: the next one takes over, and the dead holder\u2019s command is stopped first', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const cmdPid = Number(readFileSync(join(m.cache, 'a.ran'), 'utf8'))
    expect(alive(cmdPid)).toBe(true)
    // the holder writes its command's group into its run record just after starting it: under load, after a.ran. A holder
    // killed before that has left nothing to stop, which is not the case this test is about
    await m.until(() => m.recorded(cmdPid))
    process.kill(a.c.pid as number, 'SIGKILL') // the wrapper only: its command keeps running, as it would
    await a.done
    // the next one's own command looks: the dead holder's command is gone before it runs, not some time after
    const look = `if kill -0 ${cmdPid} 2>/dev/null; then echo "still running: $(ps -o stat= -p ${cmdPid})"; else echo stopped; fi`
    const r = m.run(['run', 'next', '--', 'sh', '-c', look], { HEAVY_LOCK_TIMEOUT: secs(20) })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim(), r.stderr).toBe('stopped') // never two heavy jobs at once
  })

  // heavy-lock.sh's records and ci-local's runs: the same rule for both (an older heavy-lock.sh marked its own `strict`)
  for (const kind of ['heavy-lock', 'ci-local'])
    it(`a dead ${kind} holder\u2019s recorded group whose number now belongs to another group (its leader gone) is not signalled`, async () => {
      const m = machine()
      // another group, not ours: its leader starts a member, then exits, so the group lives on with no process of its number
      const other = spawn('sh', ['-c', `sleep ${30 * F} & echo $! > "${m.cache}/member"; exec sleep 0.5`], {
        detached: true,
      })
      kids.push(other)
      await m.until(() => existsSync(join(m.cache, 'member')))
      const pgid = other.pid as number
      const member = Number(readFileSync(join(m.cache, 'member'), 'utf8'))
      await m.until(() => !alive(pgid)) // the leader is gone; its group (the member) is still there
      expect(alive(member)).toBe(true)
      // a holder that died, whose run record (as heavy-lock.sh writes it) names that group number with the leader it had
      const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
      const owner = `${gone}\nThu Jan  1 00:00:00 1970\nnonce-dead\n`
      mkdirSync(m.lock, { recursive: true })
      writeFileSync(join(m.lock, 'owner'), owner)
      const rec = join(m.cache, 'runs', 'nonce-dead')
      mkdirSync(rec, { recursive: true })
      writeFileSync(join(rec, 'owner'), owner)
      writeFileSync(join(rec, 'groups'), `${pgid} Thu Jan  1 00:00:00 1970\n`)
      if (kind === 'heavy-lock') writeFileSync(join(rec, 'strict'), '')
      const r = m.run(['run', 'next', '--', 'echo', 'ran'], { HEAVY_LOCK_TIMEOUT: secs(10) })
      expect(r.status, r.stderr).toBe(0)
      expect(alive(member)).toBe(true) // a group we can't prove is ours is left alone: a leak, never a kill
      expect(r.stderr).toContain(`left group ${pgid} running`) // and said, so a stray can be found
      process.kill(member, 'SIGKILL')
    })

  it('a run ending itself (own) still stops what its jobs left in a group whose leader has exited; a reap of another run leaves it', async () => {
    for (const own of [true, false]) {
      const m = machine()
      const g = spawn('sh', ['-c', `sleep ${30 * F} & echo $! > "${m.cache}/member"; exec sleep 0.5`], {
        detached: true,
      })
      kids.push(g)
      await m.until(() => existsSync(join(m.cache, 'member')))
      const member = Number(readFileSync(join(m.cache, 'member'), 'utf8'))
      const start = procStart(g.pid as number)
      await m.until(() => !alive(g.pid as number))
      writeFileSync(join(m.cache, 'groups'), `${g.pid} ${start}\n`)
      const r = spawnSync(
        'bash',
        [
          '-c',
          `CI_NONCE=t CI_HELD= CI_MARKER=; . "${join(here, 'ci-local/locks.sh')}"; ci_stop_groups "${m.cache}/groups" ${own ? 'own' : ''}`,
        ],
        { encoding: 'utf8' },
      )
      expect(r.status, r.stderr).toBe(0)
      expect(alive(member), `own=${own}`).toBe(!own)
      if (!own) {
        expect(r.stderr).toContain(`left group ${g.pid} running`)
        process.kill(member, 'SIGKILL')
      }
    }
  })

  it('a waiter that died leaves a ticket that is skipped, not waited for', () => {
    const m = machine()
    mkdirSync(m.queue, { recursive: true })
    const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    writeFileSync(join(m.queue, '0000000001.000000.1.1'), `${gone}\nThu Jan  1 00:00:00 1970\nn\nold waiter\n`)
    const r = m.run(['run', 'next', '--', 'echo', 'ran'], { HEAVY_LOCK_TIMEOUT: secs(5) })
    expect(r.status, r.stderr).toBe(0)
    expect(m.tickets()).toEqual([])
  })
})

describe('heavy-lock.sh: nested use, and a token that is no longer good', () => {
  it('a heavy-lock run inside a holder passes straight through, and `held` says so', () => {
    const m = machine()
    const r = m.run(
      ['run', 'outer', '--', 'sh', '-c', `bash "${HL}" held && bash "${HL}" run inner -- echo inner-ran`],
      { HEAVY_LOCK_TIMEOUT: secs(3) },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('inner-ran\n')
    expect(m.run(['held']).status).toBe(1) // outside, nothing is held
  })

  it('a token from a holder that is done, or another holder, does not skip the queue', async () => {
    const m = machine()
    const leaked = m.run(['run', 'outer', '--', 'sh', '-c', 'printf %s "$TALOS_HELD_LOCKS"']).stdout
    expect(leaked).toContain('mutex-suites')
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    for (const token of [leaked, leaked.replace(/\|[^|]*\|/, '|Thu Jan  1 00:00:00 1970|')]) {
      const r = m.run(['run', 'sneak', '--', 'echo', 'sneaked'], { TALOS_HELD_LOCKS: token, HEAVY_LOCK_TIMEOUT: '1' })
      expect(r.status).toBe(75)
      expect(r.stdout).toBe('')
      expect(m.run(['held'], { TALOS_HELD_LOCKS: token }).status).toBe(1)
    }
    a.go()
    await a.done
  })
})

describe('heavy-lock.sh: the guard (one hook, absent = allow)', () => {
  const guard = (m: ReturnType<typeof machine>, body: string) => {
    const g = join(m.cache, 'guard')
    writeFileSync(g, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return { TALOS_HEAVY_GUARD: g }
  }

  it('exit 75: the job waits, keeps its place, and does not hold the lock meanwhile; then 0 lets it run', () => {
    const m = machine()
    const n = join(m.cache, 'asked')
    // the first two asks say not now; each records whether the lock exists while the waiter is told to wait
    const env = guard(
      m,
      `echo "$1" >> "${n}"; [ -d "${m.lock}" ] && echo held >> "${n}.lock"; [ "$(wc -l < "${n}")" -gt 2 ] || { echo "load 40 > 20"; exit 75; }; exit 0`,
    )
    const r = m.run(['run', 'evals', '--', 'echo', 'ran'], { ...env, HEAVY_LOCK_TIMEOUT: secs(20) })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('ran\n')
    expect(readFileSync(n, 'utf8').trim().split('\n')).toEqual(['evals', 'evals', 'evals'])
    expect(existsSync(`${n}.lock`)).toBe(false)
    expect(r.stderr).toContain('the guard says not now (load 40 > 20)')
  })

  it('any other exit lets the job run, with a warning; no guard at all lets it run', () => {
    const m = machine()
    const r = m.run(['run', 'x', '--', 'echo', 'ran'], guard(m, 'exit 3'))
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('the guard failed (exit 3); running anyway')
    expect(m.run(['run', 'x', '--', 'echo', 'ran']).stdout).toBe('ran\n') // TALOS_HEAVY_GUARD names a file that isn't there
  })
})

describe('the gate and the Swift suites take the heavy lock', () => {
  // a copy of gate.sh alone runs its suites unlocked, and says so; the checkout's own must find the lock where it calls it, so a
  // rename or a move can't switch the lock off for everyone without a red here
  it("this checkout's gate.sh and desktop ci.sh find heavy-lock.sh where they call it", () => {
    const gate = readFileSync(join(here, 'gate.sh'), 'utf8')
    expect(gate).toContain('bash scripts/heavy-lock.sh run ')
    expect(gate).toContain('[ ! -f scripts/heavy-lock.sh ]')
    expect(existsSync(join(here, '..', 'scripts/heavy-lock.sh'))).toBe(true)
    const ci = readFileSync(join(here, '../apps/desktop/scripts/ci.sh'), 'utf8')
    expect(ci).toContain('HEAVY_LOCK="$(dirname "$0")/../../../scripts/heavy-lock.sh"')
    expect(existsSync(join(here, '../apps/desktop/scripts', '../../../scripts/heavy-lock.sh'))).toBe(true)
    expect(existsSync(join(here, 'ci-local/locks.sh'))).toBe(true) // what heavy-lock.sh sources
  })

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    HEAVY_LOCK_POLL: '0.1',
  }
  const withLock = (T: string) => {
    mkdirSync(join(T, 'scripts/ci-local'), { recursive: true })
    cpSync(join(here, 'heavy-lock.sh'), join(T, 'scripts/heavy-lock.sh'))
    cpSync(join(here, 'ci-local/locks.sh'), join(T, 'scripts/ci-local/locks.sh'))
  }

  it('gate.sh: typecheck, lint, personal and size run outside the lock, the suites inside it, and wait for it', async () => {
    const T = tmp()
    const cache = tmp()
    const git = (...a: string[]) => spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    withLock(T)
    cpSync(join(here, 'gate.sh'), join(T, 'scripts/gate.sh'))
    cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
    cpSync(join(here, 'talos-machine.sh'), join(T, 'scripts/talos-machine.sh'))
    writeFileSync(join(T, 'scripts/check-no-personal.sh'), 'exit 0\n')
    writeFileSync(join(T, 'scripts/thing.sh'), 'x\n')
    writeFileSync(join(T, 'scripts/thing.test.ts'), "const s = 'scripts/thing.sh'\n")
    mkdirSync(join(T, 'node_modules/.bin'), { recursive: true })
    writeFileSync(join(T, 'node_modules/.bin/biome'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(T, '.gitignore'), 'node_modules\nbin\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(T, 'scripts/thing.sh'), 'y\n')
    git('commit', '-qam', 'change')
    // pnpm writes down each call and whether it runs under the heavy lock
    const bin = join(T, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\nif bash "${T}/scripts/heavy-lock.sh" held; then h=held; else h=free; fi\necho "$h $*" >> "${T}/pnpm.log"\nexit 0\n`,
      { mode: 0o755 },
    )
    const genv = {
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      TALOS_CI_CACHE: cache,
      TALOS_HEAVY_GUARD: join(cache, 'none'),
    }
    const g = spawnSync('bash', ['scripts/gate.sh', '--base', base], { cwd: T, env: genv, encoding: 'utf8' })
    expect(g.status, g.stderr).toBe(0)
    const log = readFileSync(join(T, 'pnpm.log'), 'utf8').trim().split('\n')
    expect(log.filter((l) => l.startsWith('held'))).toEqual([expect.stringMatching(/^held exec vitest related --run /)])
    expect(log.filter((l) => l.startsWith('free')).map((l) => l.split(' ')[1])).toEqual(['-s', 'exec'])
    // another holder: the light steps still run, the suites wait for it, and give up at the timeout with the gate refused
    const h = spawn('bash', [join(T, 'scripts/heavy-lock.sh'), 'run', 'ci', '--', 'sleep', '300'], { env: genv })
    kids.push(h)
    // until it holds the lock (its command is running), however slow the machine: after a fixed 0.5 s it might not yet
    await vi.waitUntil(() => existsSync(join(cache, 'locks/mutex-suites/argv')), { timeout: 30_000 * F, interval: 50 })
    rmSync(join(T, 'pnpm.log'))
    const w = spawnSync('bash', ['scripts/gate.sh', '--base', base], {
      cwd: T,
      env: { ...genv, HEAVY_LOCK_TIMEOUT: '1' },
      encoding: 'utf8',
    })
    expect(w.status).toBe(1)
    expect(w.stderr).toContain(`waiting for the heavy lock, held by pid ${h.pid} (ci: sleep 300`)
    expect(w.stderr).toContain('gate: REFUSED: the tests could not get the heavy lock')
    expect(readFileSync(join(T, 'pnpm.log'), 'utf8')).not.toMatch(/vitest related/)
  })

  it('desktop ci.sh runs itself again under the lock with its arguments exactly, and only once', () => {
    const T = tmp()
    withLock(T)
    const d = join(T, 'apps/desktop/scripts')
    mkdirSync(d, { recursive: true })
    cpSync(join(here, '../apps/desktop/scripts/ci.sh'), join(d, 'ci.sh'))
    const log = join(T, 'calls.log')
    // every script ci.sh calls: write down its name, its arguments one per line, and whether the heavy lock is held
    const stub = `#!/bin/sh\n{ echo "== $(basename "$0") $(bash "${T}/scripts/heavy-lock.sh" held && echo held || echo free)"; for a in "$@"; do echo "[$a]"; done; } >> "${log}"\ncp "${T}/cache/locks/mutex-suites/argv" "${T}/argv.log" 2>/dev/null\ncp "${T}/cache/locks/mutex-desktop/argv" "${T}/argv-desktop.log" 2>/dev/null\nexit 0\n`
    const names = readFileSync(join(d, 'ci.sh'), 'utf8').match(/scripts\/[a-z0-9-]+\.sh/g) ?? []
    for (const n of new Set(names)) {
      const p = n.startsWith('scripts/ci-swift') ? join(T, n) : join(T, 'apps/desktop', n)
      if (!existsSync(p)) writeFileSync(p, stub, { mode: 0o755 })
    }
    chmodSync(join(d, 'ci.sh'), 0o755)
    const out = 'out dir/with "quotes" and  two  spaces'
    const r = spawnSync('bash', [join(d, 'ci.sh'), out, '', 'last'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: T,
        TALOS_CI_CACHE: join(T, 'cache'),
        TALOS_HEAVY_GUARD: join(T, 'none'),
      },
      encoding: 'utf8',
    })
    expect(r.status, r.stderr).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls).not.toContain(' free') // every step ran under the lock
    expect(calls).toContain(`== build-app.sh held\n[--release]\n[--out]\n[${out}]\n`) // $1 came through whole
    expect(calls.match(/== build-app\.sh/g)).toHaveLength(1) // re-run once, not looping
    // the command the lock holds is ci.sh itself with every argument as given, the empty one too
    const argv = readFileSync(join(T, 'argv.log'), 'utf8').split('\0').slice(0, -1)
    expect(argv).toEqual(['bash', join(d, 'ci.sh'), out, '', 'last'])
    // and the desktop mutex too, inside the heavy lock (the order CI takes them in): one Swift suite on the machine at a time
    const dargv = readFileSync(join(T, 'argv-desktop.log'), 'utf8').split('\0').slice(0, -1)
    expect(dargv).toEqual(['bash', join(d, 'ci.sh'), out, '', 'last'])
    // inside a CI job (any ci-local, old or new, exports TALOS_CI_SLOT_RUN=1) it never waits on the lock its own run holds,
    // whether or not that run says so in TALOS_HELD_LOCKS (an older ci-local doesn't)
    const other = spawn('bash', [join(T, 'scripts/heavy-lock.sh'), 'run', 'ci-old', '--', 'sleep', '30'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: T,
        TALOS_CI_CACHE: join(T, 'cache'),
        TALOS_HEAVY_GUARD: join(T, 'none'),
      },
    })
    kids.push(other)
    // until it holds the lock (its command is running), however slow the machine: a fixed sleep could pass the check below
    // with nobody holding it
    spawnSync('bash', ['-c', `until [ -e "${join(T, 'cache/locks/mutex-suites/argv')}" ]; do sleep 0.05; done`], {
      timeout: 30_000 * F,
    })
    expect(existsSync(join(T, 'cache/locks/mutex-suites/argv'))).toBe(true)
    const inCi = spawnSync('bash', [join(d, 'ci.sh'), 'x'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: T,
        TALOS_CI_CACHE: join(T, 'cache'),
        TALOS_HEAVY_GUARD: join(T, 'none'),
        TALOS_CI_SLOT_RUN: '1',
        HEAVY_LOCK_TIMEOUT: '2',
      },
      encoding: 'utf8',
    })
    expect(inCi.status, inCi.stderr).toBe(0)
    expect(inCi.stderr).not.toContain('waiting for')
  })
})

// gate-push.sh's checked red-main gate goes ahead of queued CI. Its ticket says so (HEAVY_LOCK_JUMP=1 when it asked), so every
// waiter, whatever its own settings, reads the same order. A holder is never stopped.
describe('heavy lock: a gate that jumps the queue once', () => {
  it('a jumping gate that asked after CI goes before it; the holder is not stopped; the wait log says jump', async () => {
    const m = machine()
    const a = m.hold('gate-a')
    await m.until(() => m.ran('gate-a'))
    const c = spawn(
      'bash',
      [
        '-c',
        `CI_NONCE=ci-c-$$; CI_HELD=; CI_MARKER=; CI_POLL=0.1; CI_LOCK_TIMEOUT=60; CI_LOCK_GRACE=30; CI_SLOT=1; RUN_DIR=; ` +
          `. "${LOCKS_SH}"; ci_mutex "${m.cache}/locks" suites sh -c 'echo $$ > "${m.cache}/ci-c.ran"; while [ ! -f "${m.cache}/ci-c.go" ] && kill -0 $PPID 2>/dev/null; do sleep 0.05; done'`,
      ],
      { env: m.env },
    )
    kids.push(c)
    await m.until(() => m.tickets().length === 1)
    const b = m.hold('gate-b', { HEAVY_LOCK_JUMP: '1' })
    await m.until(() => m.tickets().length === 2)
    await oneSecondPast(m, b) // a wait of a second or more is logged
    expect(m.ran('gate-b')).toBe(false) // a running holder is never stopped
    a.go()
    await m.until(() => m.ran('gate-b'))
    expect(m.ran('ci-c')).toBe(false)
    b.go()
    await m.until(() => m.ran('ci-c'))
    writeFileSync(join(m.cache, 'ci-c.go'), '')
    expect([await a.done, await b.done]).toEqual([0, 0])
    const rows = readFileSync(join(m.cache, 'logs/lock-waits.tsv'), 'utf8')
    expect(rows).toMatch(/\tsuites\tgate-b: [^\t]*\[jump\]\t/)
  })

  it('the jump is not passed on to what the gate runs (a nested CI run in its tests must not jump too)', () => {
    const m = machine()
    const r = m.run(['run', 'g', '--', 'sh', '-c', 'echo "[$HEAVY_LOCK_JUMP]"'], { HEAVY_LOCK_JUMP: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('[]')
  })
})

// CI is served before every waiting gate and builder job, however long they have waited. A ticket is CI only by its kind line
// (line 6 "ci", which ci_mutex writes only for a ci-local slot: heavy-lock.sh always writes "push" or "run"), or, for an old
// ticket with no kind line, by its "slot N". Only a jump ticket (line 5) goes before CI.
describe('heavy lock queue order by kind: only a jump goes before CI', () => {
  type Fake = { tag: string; age: number; what: string; jump?: boolean; kind?: string }
  // fake tickets with fake ages, all owned by this (living) test process, then ci_queue_order's order as tags
  const order = (fakes: Fake[]) => {
    const q = tmp()
    const start = procStart(process.pid)
    expect(start).not.toBe('')
    const now = Date.now() / 1000
    const byPath: Record<string, string> = {}
    fakes.forEach((f, i) => {
      const p = join(q, `${(now - f.age).toFixed(6).padStart(17, '0')}.${process.pid}.${i}`)
      const lines = [String(process.pid), start, `n${i}`, f.what]
      if (f.jump || f.kind !== undefined) lines.push(f.jump ? 'jump' : '')
      if (f.kind !== undefined) lines.push(f.kind)
      writeFileSync(p, `${lines.join('\n')}\n`)
      byPath[p] = f.tag
    })
    const r = spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_queue_order "$1" "$1/none"`, '_', q], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((p) => byPath[p] ?? p)
  }
  const ci = (tag: string, age: number): Fake => ({ tag, age, what: 'slot 1', kind: 'ci' })
  const run = (tag: string, age: number): Fake => ({ tag, age, what: `${tag}: pnpm exec vitest run`, kind: 'run' })
  const push = (tag: string, age: number): Fake => ({
    tag,
    age,
    what: `gate (${tag}): bash scripts/gate.sh`,
    kind: 'push',
  })

  it('a builder run that has waited past the cap stays behind a CI slot', () => {
    expect(order([run('burn', 4000), ci('ci', 10)])).toEqual(['ci', 'burn'])
  })

  it('a push gate stays behind CI however long it has waited; only a jump goes first', () => {
    expect(order([push('late', 40000), ci('ci', 10)])).toEqual(['ci', 'late'])
    expect(order([push('fresh', 100), ci('ci', 10)])).toEqual(['ci', 'fresh'])
    expect(order([push('p', 4000), { ...push('red', 5), jump: true }, ci('ci', 10)])).toEqual(['red', 'ci', 'p'])
  })

  it('gates and builders go first come first served behind CI, late or not', () => {
    expect(
      order([run('b1', 5000), push('p', 3000 - 1500), run('b2', 3000), run('b3', 10), ci('c1', 20), ci('c2', 5)]),
    ).toEqual(['c1', 'c2', 'b1', 'b2', 'p', 'b3'])
  })

  it('an old ticket with no kind line is a builder run, even a gate past the cap; its jump still counts', () => {
    const old = { tag: 'old', age: 4000, what: 'gate (x): bash scripts/gate.sh --in-heavy-lock' }
    expect(order([old, ci('ci', 10)])).toEqual(['ci', 'old'])
    expect(order([{ ...old, tag: 'oldjump', age: 5, jump: true }, ci('ci', 10)])).toEqual(['oldjump', 'ci'])
  })

  it('CI is told by the kind line, not the name: a run or gate named "slot 1" is not CI; an old slot ticket with no kind still is', () => {
    expect(order([{ ...run('named', 5), what: 'slot 1: sh -c x' }, push('p', 4000)])).toEqual(['p', 'named'])
    expect(order([{ ...push('gate', 5), what: 'slot 2' }, run('b', 4000)])).toEqual(['b', 'gate'])
    expect(order([run('b', 4000), { tag: 'oldci', age: 5, what: 'slot 1' }])).toEqual(['oldci', 'b'])
  })

  it('a command with newlines in it stays on its ticket line: a line "jump" or "ci" in a script makes no jump and no CI', async () => {
    const m = machine()
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const w = spawn('bash', [HL, 'run', 'multi', '--', 'sh', '-c', 'exit 0\njump\nci\n'], { env: m.env })
    kids.push(w)
    const done = new Promise<number | null>((r) => w.on('exit', (code) => r(code)))
    await m.until(() => m.tickets().filter((t) => !t.endsWith('.part')).length === 1)
    const lines = readFileSync(join(m.queue, m.tickets()[0]), 'utf8').split('\n')
    expect(lines.slice(3)).toEqual(['multi: sh -c exit 0 jump ci ', '', 'run', ''])
    a.go()
    expect([await a.done, await done]).toEqual([0, 0])
  })

  it('a ticket records its kind (ci, push, run); CI, then a fresh push gate and a run in turn; the push mark is not passed on; the log has the kind', async () => {
    const m = machine()
    const live = () => m.tickets().filter((t) => !t.endsWith('.part')).length
    const a = m.hold('a')
    await m.until(() => m.ran('a'))
    const p = m.hold('p', { HEAVY_LOCK_PUSH: '1' })
    await m.until(() => live() === 1)
    const b = m.hold('b')
    await m.until(() => live() === 2)
    const c = spawn(
      'bash',
      [
        '-c',
        `CI_NONCE=ci-c-$$; CI_HELD=; CI_MARKER=; CI_POLL=0.1; CI_LOCK_TIMEOUT=${secs(60)}; CI_LOCK_GRACE=30; CI_SLOT=1; RUN_DIR=; ` +
          `. "${LOCKS_SH}"; ci_mutex "${m.cache}/locks" suites sh -c 'echo $$ > "${m.cache}/c.ran"; while [ ! -f "${m.cache}/c.go" ] && kill -0 $PPID 2>/dev/null; do sleep 0.05; done'`,
      ],
      { env: m.env },
    )
    kids.push(c)
    const cDone = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    await m.until(() => live() === 3)
    const lines = m
      .tickets()
      .filter((t) => !t.endsWith('.part'))
      .sort()
      .map((t) => readFileSync(join(m.queue, t), 'utf8').split('\n'))
    expect(lines.map((l) => [l[3]?.split(':')[0], l[4], l[5]])).toEqual([
      ['p', '', 'push'],
      ['b', '', 'run'],
      ['slot 1', '', 'ci'],
    ])
    await oneSecondPast(m, b)
    a.go()
    await m.until(() => m.ran('c')) // CI first, then the fresh push gate and the builder run in their turn
    expect(m.ran('p') || m.ran('b')).toBe(false)
    writeFileSync(join(m.cache, 'c.go'), '')
    await m.until(() => m.ran('p'))
    expect(m.ran('b')).toBe(false)
    p.go()
    await m.until(() => m.ran('b'))
    b.go()
    expect([await a.done, await p.done, await b.done, await cDone]).toEqual([0, 0, 0, 0])
    const rows = readFileSync(join(m.cache, 'logs/lock-waits.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('\t'))
    expect(rows.find((r) => r[2]?.startsWith('p: '))?.[5]).toBe('push')
    expect(rows.find((r) => r[2]?.startsWith('b: '))?.[5]).toBe('run')
    expect(rows.find((r) => r[2] === 'slot 1')?.[5]).toBe('ci')
    const r = m.run(['run', 'g', '--', 'sh', '-c', 'echo "[$HEAVY_LOCK_PUSH]"'], { HEAVY_LOCK_PUSH: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('[]')
  })
})

// Two Swift suites at once exhaust the machine's ptys (kern.tty.ptmx_max 511; one test process peaked at 437), and tmux then fails
// to fork: tests report start_failed. So every Swift desktop test run takes the desktop mutex, the one CI's desktop job holds.
describe('the desktop mutex: one Swift desktop suite on the machine at a time', () => {
  const holdDesktop = (m: ReturnType<typeof machine>, tag: string) => {
    const c = spawn(
      'bash',
      [
        HL,
        'desktop',
        tag,
        '--',
        'sh',
        '-c',
        `echo "$$" > "${m.cache}/${tag}.ran"; while [ ! -f "${m.cache}/${tag}.go" ]; do sleep 0.05; done`,
      ],
      { env: m.env },
    )
    kids.push(c)
    let err = ''
    c.stderr?.on('data', (d) => {
      err += d
    })
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    return { done, err: () => err, go: () => writeFileSync(join(m.cache, `${tag}.go`), '') }
  }

  it('heavy-lock.sh desktop holds locks/mutex-desktop: a second waits, the heavy lock is not taken, held desktop says so', async () => {
    const m = machine()
    const a = holdDesktop(m, 'd1')
    await m.until(() => m.ran('d1'))
    expect(existsSync(join(m.cache, 'locks/mutex-desktop/owner'))).toBe(true)
    expect(existsSync(join(m.cache, 'locks/mutex-suites'))).toBe(false)
    expect(m.run(['run', 'other', '--', 'true']).status).toBe(0) // the heavy lock is free
    const w = m.run(['desktop', 'd2', '--', 'true'], { HEAVY_LOCK_TIMEOUT: '1' })
    expect(w.status).toBe(75)
    expect(w.stderr).toContain('waiting for the desktop mutex')
    expect(m.run(['held', 'desktop']).status).toBe(1) // not inside it
    a.go()
    expect(await a.done).toBe(0)
    const inside = m.run(['desktop', 'x', '--', 'bash', HL, 'held', 'desktop'])
    expect(inside.status, inside.stderr).toBe(0)
  })

  it("apps/desktop/scripts/test.sh (every swift test of the app) takes it, waits for it, and passes straight through inside CI's job", async () => {
    const T = tmp()
    mkdirSync(join(T, 'scripts/ci-local'), { recursive: true })
    cpSync(join(here, 'heavy-lock.sh'), join(T, 'scripts/heavy-lock.sh'))
    cpSync(join(here, 'ci-local/locks.sh'), join(T, 'scripts/ci-local/locks.sh'))
    mkdirSync(join(T, 'apps/desktop/scripts'), { recursive: true })
    cpSync(join(here, '../apps/desktop/scripts/test.sh'), join(T, 'apps/desktop/scripts/test.sh'))
    const bin = join(T, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'swift'),
      `#!/bin/sh\nif bash "${T}/scripts/heavy-lock.sh" held desktop; then echo held; else echo free; fi > "${T}/swift.ran"\n`,
      { mode: 0o755 },
    )
    writeFileSync(join(bin, 'xcodebuild'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: T,
      TALOS_CI_CACHE: join(T, 'cache'),
      TALOS_HEAVY_GUARD: join(T, 'none'),
      HEAVY_LOCK_POLL: '0.1',
    }
    const t = join(T, 'apps/desktop/scripts/test.sh')
    const r = spawnSync('bash', [t, '--filter', 'X'], { env, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(T, 'swift.ran'), 'utf8').trim()).toBe('held')
    // another suite holds it: test.sh waits, and gives up at the timeout without running swift
    rmSync(join(T, 'swift.ran'))
    const other = spawn('bash', [join(T, 'scripts/heavy-lock.sh'), 'desktop', 'other', '--', 'sleep', '300'], { env })
    kids.push(other)
    // until it holds the mutex (its command is running), however slow the machine: no fixed sleep decides it
    await vi.waitUntil(() => existsSync(join(T, 'cache/locks/mutex-desktop/argv')), {
      timeout: 50_000 * F,
      interval: 50,
    })
    const w = spawnSync('bash', [t], { env: { ...env, HEAVY_LOCK_TIMEOUT: '1' }, encoding: 'utf8' })
    expect(w.status).toBe(75)
    expect(w.stderr).toContain('waiting for the desktop mutex')
    expect(existsSync(join(T, 'swift.ran'))).toBe(false)
    // inside a CI job (its desktop job holds the mutex already): no wait
    const ci = spawnSync('bash', [t], {
      env: { ...env, TALOS_CI_SLOT_RUN: '1', HEAVY_LOCK_TIMEOUT: '1' },
      encoding: 'utf8',
    })
    expect(ci.status, ci.stderr).toBe(0)
  })
})
