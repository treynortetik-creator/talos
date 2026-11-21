// A gate's heavy hold and a CI run never overlap on one machine (scripts/ci-local/turn.sh): fake machines (a temp cache each), the
// real heavy-lock.sh for the gate side and ci_acquire_slot for the CI side, no real CI. Nobody is stopped, the two classes go first
// come first served, a wait is bounded and said, a CI run that waits too long fails open.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { timeFactor } from '../packages/testkit/src/time-factor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const HL = join(here, 'heavy-lock.sh')
const LOCKS_SH = join(here, 'ci-local/locks.sh')
const F = timeFactor()
vi.setConfig({ testTimeout: 60_000 * F, hookTimeout: 60_000 * F })
const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(async () => {
  const live = kids.splice(0).filter((k) => k.pid && k.exitCode === null)
  for (const k of live) spawnSync('kill', ['-TERM', String(k.pid)])
  await Promise.all(
    live.map(
      (k) =>
        new Promise<void>((r) => {
          if (k.exitCode !== null) return r()
          const timer = setTimeout(r, 5_000 * F)
          k.once('exit', () => {
            clearTimeout(timer)
            r()
          })
        }),
    ),
  )
  for (const k of live) if (k.exitCode === null) spawnSync('kill', ['-KILL', String(k.pid)])
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// four heavy slots, CI's are 1 and 2, the gates' 3 and 4
function machine(extra: Record<string, string> = {}) {
  const cache = mkdtempSync(join(tmpdir(), 'turn-'))
  dirs.push(cache)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: cache,
    TALOS_CI_CACHE: cache,
    TALOS_HEAVY_SLOTS: '4',
    TALOS_CI_SLOTS: '2',
    HEAVY_LOCK_POLL: '0.1',
    TALOS_HEAVY_GUARD: join(cache, 'no-guard'),
    ...extra,
  }
  const locks = join(cache, 'locks')
  const until = async (f: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms * F
    while (!f()) {
      if (Date.now() > end) throw new Error('timed out')
      await sleep(50)
    }
  }
  const ran = (tag: string) => existsSync(join(cache, `${tag}.ran`))
  const track = (c: ChildProcess) => {
    const out: string[] = []
    kids.push(c)
    c.stderr?.on('data', (d) => out.push(String(d)))
    c.stdout?.on('data', (d) => out.push(String(d)))
    const done = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    return { c, done, err: () => out.join(''), go: () => writeFileSync(join(cache, `${tag(c)}.go`), '') }
  }
  const tags = new WeakMap<ChildProcess, string>()
  const tag = (c: ChildProcess) => tags.get(c) ?? ''
  // a gate hold (heavy-lock.sh run): its command writes <tag>.ran and waits for <tag>.go
  const gate = (name: string, more: Record<string, string> = {}) => {
    const c = spawn(
      'bash',
      [
        HL,
        'run',
        name,
        '--',
        'sh',
        '-c',
        `echo "$$" > "${cache}/${name}.ran"; while [ ! -f "${cache}/${name}.go" ]; do sleep 0.05; done`,
      ],
      { env: { ...env, ...more } },
    )
    tags.set(c, name)
    return track(c)
  }
  // a CI run: takes a run slot as ci-local.sh does (ci_acquire_slot), writes <tag>.ran, waits for <tag>.go, releases. inner: it then
  // takes a CI slot of the suites mutex the way a job does (no CI_MUTEX_WHAT: a ci ticket) and writes <tag>.inner
  const ci = (name: string, more: Record<string, string> = {}, inner = false) => {
    const script = join(cache, `${name}.ci.sh`)
    writeFileSync(
      script,
      `CI_NONCE="$$-$RANDOM-$(date +%s)"; CI_HELD="" CI_SLOT="" CI_MARKER=""
CI_LOCAL_LIB="${join(here, 'ci-local')}"; CACHE="${cache}"; LOCKS="${locks}"
CI_SLOTS=3 CI_MAX_LOAD=0 CI_POLL=\${CI_POLL:-0.1} CI_LOCK_TIMEOUT=\${CI_LOCK_TIMEOUT:-60} CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "${name}" || exit 1
echo "$$" > "${cache}/${name}.ran"
${inner ? `ci_mutex "$LOCKS" suites touch "${cache}/${name}.inner"` : ''}
while [ ! -f "${cache}/${name}.go" ]; do sleep 0.05; done
`,
    )
    const c = spawn('bash', [script], { env: { ...env, ...more } })
    tags.set(c, name)
    return track(c)
  }
  const alerts = () =>
    existsSync(join(cache, 'alerts')) ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('.txt')) : []
  const status = () => spawnSync('bash', [HL, 'status'], { env, encoding: 'utf8' }).stdout
  const queue = (q: string) =>
    existsSync(join(cache, 'locks.queue', q)) ? readdirSync(join(cache, 'locks.queue', q)) : []
  const fakeHolder = (lockName: string) => {
    // a lock whose owner process is gone
    const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    const lock = join(locks, lockName)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), `${dead}\n\n${dead}-x-1\n`)
    writeFileSync(join(lock, 'what'), 'a crashed holder\n')
  }
  return { cache, env, locks, until, ran, gate, ci, alerts, status, queue, fakeHolder }
}

describe('gate and CI take turns', () => {
  it('a gate waits for a CI run that is on, says so, and the run is never stopped', async () => {
    const m = machine()
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => /CI runs hold the machine/.test(g.err()))
    await sleep(500)
    expect(m.ran('g1')).toBe(false)
    expect(g.err()).toMatch(/pid \d+ \(runA/)
    run.go()
    expect(await run.done).toBe(0)
    await m.until(() => m.ran('g1'))
    g.go()
    expect(await g.done).toBe(0)
  })

  it('a CI run waits at its start for a gate that is on; the gate is never stopped', async () => {
    const m = machine()
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const run = m.ci('runA')
    await m.until(() => /a gate holds the machine/.test(run.err()))
    await sleep(500)
    expect(m.ran('runA')).toBe(false)
    g.go()
    expect(await g.done).toBe(0)
    await m.until(() => m.ran('runA'))
    run.go()
    expect(await run.done).toBe(0)
  })

  it('first come first served: CI that arrives after a waiting gate goes behind it', async () => {
    const m = machine()
    const a = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => m.queue('suites').length === 1)
    const b = m.ci('runB') // arrives after the gate: not admitted just because CI is on
    await m.until(() => /gates queued before this run go first/.test(b.err()))
    await sleep(500)
    expect(m.ran('runB')).toBe(false)
    a.go()
    await m.until(() => m.ran('g1'))
    expect(m.ran('runB')).toBe(false)
    g.go()
    await m.until(() => m.ran('runB'))
    b.go()
    expect(await b.done).toBe(0)
  })

  it('first come first served: a gate that arrives after waiting CI goes behind it, though a gate slot is free', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const c = m.ci('runC')
    await m.until(() => m.queue('admit').length === 1)
    const g2 = m.gate('g2') // slot 4 is free, and a gate is on, but a CI run queued before it
    await m.until(() => /CI runs queued before this gate go first/.test(g2.err()))
    await sleep(500)
    expect(m.ran('g2')).toBe(false)
    g1.go()
    await m.until(() => m.ran('runC'))
    expect(m.ran('g2')).toBe(false)
    c.go()
    await m.until(() => m.ran('g2'))
    g2.go()
    expect(await g2.done).toBe(0)
  })

  it('a class that is on lets a newcomer join when no older waiter of the other class is queued', async () => {
    const m = machine()
    const a = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const b = m.ci('runB')
    await m.until(() => m.ran('runB'))
    a.go()
    b.go()
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
  })

  it('a gate that cannot get its turn in HEAVY_LOCK_TIMEOUT refuses with 75 and leaves no ticket', async () => {
    const m = machine()
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1', { HEAVY_LOCK_TIMEOUT: '2' })
    expect(await g.done).toBe(75)
    expect(g.err()).toMatch(/timed out waiting for the heavy lock/)
    expect(m.queue('suites')).toEqual([])
    run.go()
  })

  it('a CI run whose process is gone does not hold a gate back, and a dead gate does not hold CI back', async () => {
    const m = machine()
    m.fakeHolder('slot-1')
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    g.go()
    expect(await g.done).toBe(0)
    const m2 = machine()
    m2.fakeHolder('mutex-suites-3')
    const run = m2.ci('runA')
    await m2.until(() => m2.ran('runA'))
    run.go()
    expect(await run.done).toBe(0)
  })

  it('a CI run that waits CI_TURN_MAX_S goes ahead beside the gate, loudly, with one alert', async () => {
    const m = machine()
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const run = m.ci('runA', { CI_TURN_MAX_S: '2' })
    await m.until(() => m.ran('runA'))
    expect(run.err()).toMatch(/beside a gate/)
    expect(m.ran('g1')).toBe(true)
    expect(m.alerts()).toHaveLength(1)
    expect(readFileSync(join(m.cache, 'alerts', m.alerts()[0] as string), 'utf8')).toMatch(/beside a gate/)
    run.go()
    g.go()
    expect(await run.done).toBe(0)
    expect(await g.done).toBe(0)
  })

  it('a long wait raises ONE alert, however often the waiter looks', async () => {
    const m = machine()
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1', { TALOS_TURN_ALERT_S: '1' })
    await m.until(() => m.alerts().length === 1)
    await sleep(1_500)
    expect(m.alerts()).toHaveLength(1)
    expect(readFileSync(join(m.cache, 'alerts', m.alerts()[0] as string), 'utf8')).toMatch(/^HEAVY TURN: .*waited/)
    run.go()
    await m.until(() => m.ran('g1'))
    g.go()
  })

  it('a wait is a row in lock-waits.tsv with kind turn', async () => {
    const m = machine()
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await sleep(1_500)
    run.go()
    await m.until(() => m.ran('g1'))
    g.go()
    await g.done
    expect(readFileSync(join(m.cache, 'logs', 'lock-waits.tsv'), 'utf8')).toMatch(
      /\tturn\t[^\t]*\t[1-9]\d*\tgot\tturn\n/,
    )
  })

  it('an admitted run goes on with its own holds while a gate waits (no deadlock)', async () => {
    const m = machine()
    const run = m.ci('runA', {}, true)
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => /CI runs hold the machine/.test(g.err()))
    await m.until(() => existsSync(join(m.cache, 'runA.inner')))
    run.go()
    await run.done
    await m.until(() => m.ran('g1'))
    g.go()
  })

  it('CI_TURN=0 and a turn-off file give the old behaviour: a gate and a run overlap', async () => {
    const m = machine({ CI_TURN: '0' })
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    run.go()
    g.go()
    const m2 = machine()
    writeFileSync(join(m2.cache, 'turn-off'), '')
    const g2 = m2.gate('g1')
    await m2.until(() => m2.ran('g1'))
    const run2 = m2.ci('runA')
    await m2.until(() => m2.ran('runA'))
    run2.go()
    g2.go()
  })

  it('with one heavy slot nothing changes (everyone shares the slot)', async () => {
    const m = machine({ TALOS_HEAVY_SLOTS: '1' })
    const run = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    expect(g.err()).not.toMatch(/CI runs hold the machine/)
    run.go()
    g.go()
  })

  it('status says who holds the machine and which runs wait', async () => {
    const m = machine()
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const run = m.ci('runA')
    await m.until(() => m.queue('admit').length === 1)
    const s = m.status()
    expect(s).toMatch(/turns: the gates': pid \d+ \(g1/)
    expect(s).toMatch(/CI runs waiting for their turn: pid \d+ \(runA\)/)
    g.go()
    await m.until(() => m.ran('runA'))
    run.go()
  })

  it('never both at once: gates and CI runs started together take turns', async () => {
    const m = machine()
    const log = join(m.cache, 'events')
    writeFileSync(log, '')
    const mk = (cls: string, i: number) => {
      const name = `${cls}${i}`
      if (cls === 'G') {
        const c = spawn(
          'bash',
          [HL, 'run', name, '--', 'sh', '-c', `echo +G >> "${log}"; sleep 0.3; echo -G >> "${log}"`],
          { env: m.env },
        )
        kids.push(c)
        return new Promise<number | null>((r) => c.on('exit', r))
      }
      const script = join(m.cache, `${name}.sh`)
      writeFileSync(
        script,
        `CI_NONCE="$$-$RANDOM-$(date +%s)"; CI_HELD="" CI_SLOT="" CI_MARKER=""
CI_LOCAL_LIB="${join(here, 'ci-local')}"; CACHE="${m.cache}"; LOCKS="${m.locks}"
CI_SLOTS=3 CI_MAX_LOAD=0 CI_POLL=0.1 CI_LOCK_TIMEOUT=120 CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "${name}" || exit 1
echo +C >> "${log}"; sleep 0.3; echo -C >> "${log}"
`,
      )
      const c = spawn('bash', [script], { env: m.env })
      kids.push(c)
      return new Promise<number | null>((r) => c.on('exit', r))
    }
    const all: Promise<number | null>[] = []
    for (let i = 0; i < 5; i++) {
      all.push(mk('G', i))
      all.push(mk('C', i))
    }
    expect(await Promise.all(all)).toEqual(Array(10).fill(0))
    let g = 0
    let c = 0
    for (const e of readFileSync(log, 'utf8').trim().split('\n')) {
      if (e === '+G') g++
      if (e === '-G') g--
      if (e === '+C') c++
      if (e === '-C') c--
      expect(g > 0 && c > 0, `overlap at ${e}`).toBe(false)
    }
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(20)
  })

  it('a gate that arrives while a gate is on joins it (gates share their own slots)', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const g2 = m.gate('g2')
    await m.until(() => m.ran('g2'))
    g1.go()
    g2.go()
    expect(await g1.done).toBe(0)
    expect(await g2.done).toBe(0)
  })

  it('a checked --red-main jump gate goes before a CI run that is queued, but not before one that is on', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const c = m.ci('runC')
    await m.until(() => m.queue('admit').length === 1)
    const j = m.gate('gj', { HEAVY_LOCK_JUMP: '1' })
    await m.until(() => m.ran('gj'))
    expect(m.ran('runC')).toBe(false)
    g1.go()
    j.go()
    await m.until(() => m.ran('runC'))
    c.go()
    const m2 = machine()
    const a = m2.ci('runA')
    await m2.until(() => m2.ran('runA'))
    const j2 = m2.gate('gj', { HEAVY_LOCK_JUMP: '1' })
    await m2.until(() => /CI runs hold the machine/.test(j2.err()))
    await sleep(500)
    expect(m2.ran('gj')).toBe(false)
    a.go()
    await m2.until(() => m2.ran('gj'))
    j2.go()
  })

  it("a dead waiter's place in the queue, and a dead holder of the turn lock, hold nobody back", async () => {
    const m = machine()
    const dead = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    mkdirSync(join(m.cache, 'locks.queue', 'admit'), { recursive: true })
    writeFileSync(
      join(m.cache, 'locks.queue', 'admit', '00000000001.000000.1.1'),
      `${dead}\n\n${dead}-x-1\na dead run\n\nci\n`,
    )
    m.fakeHolder('mutex-turn')
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    g.go()
    expect(await g.done).toBe(0)
  })

  it('a CI run that times out waiting for a slot leaves no place in the queue', async () => {
    const m = machine()
    const held = [m.ci('r1'), m.ci('r2'), m.ci('r3')]
    for (const t of ['r1', 'r2', 'r3']) await m.until(() => m.ran(t))
    const late = m.ci('r4', { CI_LOCK_TIMEOUT: '2' })
    expect(await late.done).toBe(1)
    expect(late.err()).toMatch(/lock timeout/)
    expect(m.queue('admit')).toEqual([])
    for (const h of held) h.go()
  })

  it('a run inside a holder (TALOS_CI_NESTED) does not wait for a gate', async () => {
    const m = machine()
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const run = m.ci('runA', { TALOS_CI_NESTED: '1' })
    await m.until(() => m.ran('runA'))
    run.go()
    g.go()
  })

  it('the switch is read while a run waits: a turn-off file lets it go at once', async () => {
    const m = machine()
    const g = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const run = m.ci('runA')
    await m.until(() => /a gate holds the machine/.test(run.err()))
    writeFileSync(join(m.cache, 'turn-off'), '')
    await m.until(() => m.ran('runA'))
    expect(m.queue('admit')).toEqual([])
    run.go()
    g.go()
  })

  it('a turn lock that a live holder keeps busy is a wait too: the run still fails open', async () => {
    const m = machine()
    const sleeper = spawn('sleep', ['600'])
    kids.push(sleeper)
    const pid = sleeper.pid as number
    const start = spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start ${pid}`], {
      encoding: 'utf8',
    }).stdout.trim()
    mkdirSync(join(m.locks, 'mutex-turn'), { recursive: true })
    writeFileSync(join(m.locks, 'mutex-turn', 'owner'), `${pid}\n${start}\n${pid}-x-1\n`)
    const run = m.ci('runA', { CI_TURN_MAX_S: '2' })
    await m.until(() => m.ran('runA'))
    expect(run.err()).toMatch(new RegExp(`the turn lock is busy \\(held by pid ${pid}\\)`))
    expect(run.err()).toMatch(/went ahead because the turn lock stayed busy/)
    expect(run.err()).not.toMatch(/ran beside a gate/)
    run.go()
    expect(await run.done).toBe(0)
  })

  it('the turn lock is not listed for release at every look (CI_HELD does not grow)', () => {
    const m = machine()
    const r = spawnSync(
      'bash',
      [
        '-c',
        `CI_NONCE=t CI_HELD=; . "${LOCKS_SH}"; for i in 1 2 3 4 5; do ci_turn_enter "${m.locks}" && ci_turn_leave; done; printf '[%s]' "$CI_HELD"`,
      ],
      { env: m.env, encoding: 'utf8' },
    )
    expect(r.stdout).toBe('[]')
  })

  it('a copy of locks.sh without turn.sh works as before and says so', () => {
    const m = machine()
    const dir = join(m.cache, 'copy')
    mkdirSync(dir)
    for (const f of ['locks.sh']) writeFileSync(join(dir, f), readFileSync(LOCKS_SH))
    const r = spawnSync(
      'bash',
      ['-c', `CI_NONCE=t CI_HELD=; . "${join(dir, 'locks.sh')}"; ci_turn_on "${m.locks}" || echo off`],
      {
        env: m.env,
        encoding: 'utf8',
      },
    )
    expect(r.stdout.trim()).toBe('off')
    expect(r.stderr).toMatch(/no turn\.sh beside locks\.sh/)
  })
})
