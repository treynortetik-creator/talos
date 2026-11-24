// A gate's heavy hold and a CI run never overlap on one machine (scripts/ci-local/turn.sh): fake machines (a temp cache each), the
// real heavy-lock.sh for the gate side and ci_acquire_slot for the CI side, no real CI. Nobody is stopped, the two classes go first
// come first served, a wait is bounded and said, a CI run that waits too long fails open.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  // a CI run with a run record (runs/<nonce>/jobs and results/), as ci-local.sh keeps one: it takes a run slot, lists its jobs
  // (`check` unfinished, `other` ended unless unfinished: true), writes <name>.ran, then waits for <name>.fold, goes idle
  // (ci_fold_wait: only a part on another machine is awaited) and writes <name>.idle; on <name>.resume it asks for the turn back
  // (ci_fold_resume: waits while a gate holds the machine) and writes <name>.resumed; ends on <name>.go
  const foldRun = (name: string, more: Record<string, string> = {}, unfinished = false, insideGate = false) => {
    const script = join(cache, `${name}.fold.sh`)
    writeFileSync(
      script,
      `CI_NONCE="$$-$RANDOM-$(date +%s)"; CI_HELD="" CI_SLOT="" CI_MARKER=""
CI_LOCAL_LIB="${join(here, 'ci-local')}"; CACHE="${cache}"; LOCKS="${locks}"
CI_SLOTS=3 CI_MAX_LOAD=0 CI_POLL=0.1 CI_LOCK_TIMEOUT=60 CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "${name}" || exit 1
RD="$CACHE/runs/$CI_NONCE"; mkdir -p "$RD/results"
printf 'check\nother\n' > "$RD/jobs"
${unfinished ? '' : 'echo "0 1 ok" > "$RD/results/other"'}
echo "$$" > "${cache}/${name}.ran"
while [ ! -f "${cache}/${name}.fold" ]; do sleep 0.05; done
ci_fold_wait "$RD/results" check
echo idle > "${cache}/${name}.idle"
while [ ! -f "${cache}/${name}.resume" ]; do sleep 0.05; done
ci_fold_resume "$RD/results" check "$LOCKS"
echo resumed > "${cache}/${name}.resumed"
while [ ! -f "${cache}/${name}.go" ]; do sleep 0.05; done
`,
    )
    // insideGate: the run is started by a gate's own command (heavy-lock.sh run), so it runs inside that holder
    const c = insideGate
      ? spawn('bash', [HL, 'run', `${name}-outer`, '--', 'bash', script], { env: { ...env, ...more } })
      : spawn('bash', [script], { env: { ...env, ...more } })
    tags.set(c, name)
    const t = track(c)
    const flag = (f: string) => () => writeFileSync(join(cache, `${name}.${f}`), '')
    return { ...t, fold: flag('fold'), resume: flag('resume') }
  }
  const has = (f: string) => existsSync(join(cache, f))
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
  return { cache, env, locks, until, ran, has, gate, ci, foldRun, alerts, status, queue, fakeHolder }
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

  // A scheduled run (the nightly, the hostile nightly: CI_NIGHTLY=1) leaves a free slot to a push run that is queued (locks.sh,
  // ci_acquire_slot). It never makes a gate wait (ci_turn_ahead), or the three wait for each other: the scheduled run for the push
  // run, the push run for the gate queued before it, the gate for the scheduled run queued before it.
  describe('a scheduled run and a push run', () => {
    it('a scheduled run, a gate and a push run queued in that order while a gate is on: no cycle, the gate and the push run go before the scheduled run', async () => {
      const m = machine()
      const g1 = m.gate('g1')
      await m.until(() => m.ran('g1'))
      const s = m.ci('runS', { CI_NIGHTLY: '1' })
      await m.until(() => m.queue('admit').length === 1)
      const g2 = m.gate('g2') // queued after the scheduled run, before the push run
      await m.until(() => m.queue('suites').length === 1 || m.ran('g2')) // before the fix it waits; after it, it goes at once
      const p = m.ci('runP')
      await m.until(() => m.queue('admit').length === 2)
      await m.until(() => m.ran('g2'), 15_000) // a scheduled run never makes a gate wait: it joins the gate that is on
      expect(m.ran('runP')).toBe(false)
      expect(m.ran('runS')).toBe(false)
      g1.go()
      g2.go()
      await m.until(() => m.ran('runP'), 15_000)
      expect(m.ran('runS')).toBe(false) // the push run goes first
      p.go()
      await m.until(() => m.ran('runS'), 15_000)
      s.go()
      expect([await g1.done, await g2.done, await p.done, await s.done]).toEqual([0, 0, 0, 0])
    })

    it('whatever order a scheduled run, a gate and a push run queue in behind a gate that is on, all three finish, and the push run goes before the scheduled run', async () => {
      const orders = [
        ['s', 'g', 'p'],
        ['s', 'p', 'g'],
        ['g', 's', 'p'],
        ['g', 'p', 's'],
        ['p', 's', 'g'],
        ['p', 'g', 's'],
      ]
      for (const order of orders) {
        const m = machine()
        const g1 = m.gate('g1')
        await m.until(() => m.ran('g1'))
        for (const t of ['runS', 'g2', 'runP']) writeFileSync(join(m.cache, `${t}.go`), '') // each finishes as soon as it runs
        const procs: { done: Promise<number | null> }[] = []
        for (const [k, o] of order.entries()) {
          procs.push(o === 's' ? m.ci('runS', { CI_NIGHTLY: '1' }) : o === 'p' ? m.ci('runP') : m.gate('g2'))
          // the next one starts when this one has its place in a queue (or has run), so the order of arrival is the order tested
          await m.until(() => m.queue('admit').length + m.queue('suites').length + (m.ran('g2') ? 1 : 0) >= k + 1)
        }
        g1.go()
        await Promise.race([
          Promise.all(procs.map((x) => x.done)),
          sleep(25_000 * F).then(() => {
            throw new Error(`a cycle: ${order.join(' ')}`)
          }),
        ])
        const at = (t: string) => statSync(join(m.cache, `${t}.ran`)).mtimeMs
        expect(at('runP'), order.join(' ')).toBeLessThan(at('runS'))
      }
    })

    it('a scheduled run that waits for a queued push run goes ahead after CI_TURN_MAX_S, loudly, and its lock timeout does not run out meanwhile', async () => {
      const m = machine()
      // a push run's place in the queue that never goes: a living process (the test's own sleep) and its ticket
      const idle = spawn('sleep', ['120'])
      kids.push(idle)
      const start = spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start ${idle.pid}`], {
        encoding: 'utf8',
      }).stdout.trim()
      mkdirSync(join(m.cache, 'locks.queue', 'admit'), { recursive: true })
      writeFileSync(
        join(m.cache, 'locks.queue', 'admit', '00000000000000.000001.1.1'),
        `${idle.pid}\n${start}\nidle-nonce\npush run\n\nci\n`,
      )
      // the lock timeout (2 s) is shorter than the cap (3 s): the wait for a push run does not count against it
      const s = m.ci('runS', { CI_NIGHTLY: '1', CI_TURN_MAX_S: '3', CI_LOCK_TIMEOUT: '2' })
      await m.until(() => /a push run is queued/.test(s.err()))
      expect(m.ran('runS')).toBe(false)
      await m.until(() => m.ran('runS'), 15_000)
      expect(s.err()).toMatch(/went ahead of a queued push run after \d+ min \(CI_TURN_MAX_S\)/)
      s.go()
      expect(await s.done).toBe(0)
    })

    it('a scheduled run that waited for its turn and then for a push run closes its turn row when the push wait begins, so the row does not include it', async () => {
      const m = machine()
      const g = m.gate('g1')
      await m.until(() => m.ran('g1'))
      const idle = spawn('sleep', ['120'])
      kids.push(idle)
      const start = spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start ${idle.pid}`], {
        encoding: 'utf8',
      }).stdout.trim()
      mkdirSync(join(m.cache, 'locks.queue', 'admit'), { recursive: true })
      writeFileSync(
        join(m.cache, 'locks.queue', 'admit', '00000000000000.000001.1.1'),
        `${idle.pid}\n${start}\nidle-nonce\npush run\n\nci\n`,
      )
      const s = m.ci('runS', { CI_NIGHTLY: '1', CI_TURN_MAX_S: '30' })
      await m.until(() => /a gate holds the machine/.test(s.err()))
      await sleep(1500) // timing-ok: a wait is a row in lock-waits.tsv only from one second on
      g.go() // the turn is free; the push run's place is still queued
      await m.until(() => /a push run is queued/.test(s.err()))
      const rows = () =>
        existsSync(join(m.cache, 'logs', 'lock-waits.tsv'))
          ? readFileSync(join(m.cache, 'logs', 'lock-waits.tsv'), 'utf8')
              .split('\n')
              .filter((l) => l.split('\t')[5] === 'turn')
          : []
      await m.until(() => rows().length === 1) // the turn wait is closed when the push wait begins, not at the end of it
      expect(Number(rows()[0].split('\t')[3])).toBeLessThan(10)
      s.go()
    })
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

  describe('a CI run that waits only for a part on another machine does not hold the turn', () => {
    it('every job of the run that has not ended waits on a part: a gate goes, and the run is not stopped', async () => {
      const m = machine()
      const run = m.foldRun('runA')
      await m.until(() => m.ran('runA'))
      const busy = m.gate('g0') // the run has a heavy step still going (no marker yet): the gate waits
      await m.until(() => /CI runs hold the machine/.test(busy.err()))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      await m.until(() => m.ran('g0')) // now idle: the same waiting gate goes
      expect(m.status()).toMatch(/waiting only for a part \(they do not hold the turn\): pid \d+ \(runA/)
      busy.go()
      run.resume()
      run.go()
      expect(await busy.done).toBe(0)
      expect(await run.done).toBe(0)
    })

    it('a run with another job that has not ended and is not waiting on a part still holds the turn', async () => {
      const m = machine()
      const run = m.foldRun('runA', {}, true)
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      await sleep(500) // timing-ok: a negative window, it must not have started
      expect(m.ran('g1')).toBe(false)
      run.resume()
      await m.until(() => m.has('runA.resumed'))
      run.go()
      await m.until(() => m.ran('g1'))
      g.go()
    })

    it('resuming heavy work takes the turn again: it waits while a gate holds the machine, and kills nobody', async () => {
      const m = machine()
      const run = m.foldRun('runA')
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      const g = m.gate('g1')
      await m.until(() => m.ran('g1'))
      run.resume()
      await m.until(() => /a gate holds the machine/.test(run.err()))
      await sleep(500) // timing-ok: a negative window, it must not have started
      expect(m.has('runA.resumed')).toBe(false) // it waits, it is not killed
      g.go()
      expect(await g.done).toBe(0)
      await m.until(() => m.has('runA.resumed'))
      run.go()
      expect(await run.done).toBe(0)
    })

    it('after the resume the run holds the turn again: a new gate waits for it', async () => {
      const m = machine()
      const run = m.foldRun('runA')
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      run.resume()
      await m.until(() => m.has('runA.resumed'))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      await sleep(500) // timing-ok: a negative window, it must not have started
      expect(m.ran('g1')).toBe(false)
      run.go()
      await m.until(() => m.ran('g1'))
      g.go()
    })

    it('a resume that waits CI_TURN_MAX_S for a gate goes ahead, loudly, with an alert', async () => {
      const m = machine()
      const run = m.foldRun('runA', { CI_TURN_MAX_S: '2' })
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      const g = m.gate('g1')
      await m.until(() => m.ran('g1'))
      run.resume()
      await m.until(() => m.has('runA.resumed'))
      expect(run.err()).toMatch(/resumed beside a gate/)
      expect(m.alerts()).toHaveLength(1)
      run.go()
      g.go()
    })

    it('gates that come while a take-back waits go behind it: the take-back is not pushed past its cap by a stream of gates', async () => {
      const m = machine()
      const run = m.foldRun('runA')
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      const g1 = m.gate('g1')
      await m.until(() => m.ran('g1'))
      run.resume()
      await m.until(() => /a gate holds the machine/.test(run.err()))
      const g2 = m.gate('g2') // slot 4 is free and no CI run holds: but the run that waits to go on now holds the turn
      await m.until(() => /CI runs hold the machine/.test(g2.err()))
      await sleep(500) // timing-ok: a negative window, it must not have started
      expect(m.ran('g2')).toBe(false)
      g1.go()
      await m.until(() => m.has('runA.resumed'))
      expect(m.ran('g2')).toBe(false)
      run.go()
      await m.until(() => m.ran('g2'))
      g2.go()
      expect(await g2.done).toBe(0)
    })

    it('a run started inside a gate hold does not wait for the gate it runs in', async () => {
      const m = machine()
      const run = m.foldRun('runA', {}, false, true)
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      run.resume()
      await m.until(() => m.has('runA.resumed')) // the enclosing hold is its own: no waiting for it
      run.go()
      expect(await run.done).toBe(0)
    })

    it('the switch off: the marker is simply cleared, nothing waits', async () => {
      const m = machine({ CI_TURN: '0' })
      const run = m.foldRun('runA')
      await m.until(() => m.ran('runA'))
      run.fold()
      await m.until(() => m.has('runA.idle'))
      const g = m.gate('g1')
      await m.until(() => m.ran('g1'))
      run.resume()
      await m.until(() => m.has('runA.resumed'))
      run.go()
      g.go()
    })

    it('never both at once: runs that go idle and resume, and gates, started together', async () => {
      const m = machine()
      const log = join(m.cache, 'events')
      writeFileSync(log, '')
      const all: Promise<number | null>[] = []
      for (let i = 0; i < 4; i++) {
        const c = spawn(
          'bash',
          [HL, 'run', `G${i}`, '--', 'sh', '-c', `echo +G >> "${log}"; sleep 0.3; echo -G >> "${log}"`],
          {
            env: m.env,
          },
        )
        kids.push(c)
        all.push(new Promise((r) => c.on('exit', r)))
        const script = join(m.cache, `C${i}.sh`)
        writeFileSync(
          script,
          `CI_NONCE="$$-$RANDOM-$(date +%s)"; CI_HELD="" CI_SLOT="" CI_MARKER=""
CI_LOCAL_LIB="${join(here, 'ci-local')}"; CACHE="${m.cache}"; LOCKS="${m.locks}"
CI_SLOTS=3 CI_MAX_LOAD=0 CI_POLL=0.1 CI_LOCK_TIMEOUT=120 CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "C${i}" || exit 1
RD="$CACHE/runs/$CI_NONCE"; mkdir -p "$RD/results"; printf 'check\n' > "$RD/jobs"
echo +C >> "${log}"; sleep 0.1; echo -C >> "${log}"
ci_fold_wait "$RD/results" check
sleep 0.4
ci_fold_resume "$RD/results" check "$LOCKS"
echo +C >> "${log}"; sleep 0.2; echo -C >> "${log}"
`,
        )
        const r = spawn('bash', [script], { env: m.env })
        kids.push(r)
        all.push(new Promise((res) => r.on('exit', res)))
      }
      expect(await Promise.all(all)).toEqual(Array(8).fill(0))
      let g = 0
      let c = 0
      for (const e of readFileSync(log, 'utf8').trim().split('\n')) {
        if (e === '+G') g++
        if (e === '-G') g--
        if (e === '+C') c++
        if (e === '-C') c--
        expect(g > 0 && c > 0, `overlap at ${e}`).toBe(false)
      }
    })
  })
})
