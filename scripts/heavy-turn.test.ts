// A gate's heavy hold and a CI run never overlap on one machine (scripts/ci-local/turn.sh): fake machines (a temp cache each), the
// real heavy-lock.sh for the gate side and ci_acquire_slot for the CI side, no real CI. Nobody is stopped, a waiting gate goes before a
// waiting CI run until that run is starved (2 gates or 30 min), a wait is bounded and said, a CI run that waits too long fails open.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { timeFactor } from '../packages/testkit/src/time-factor.ts'
import { waitForFile } from './wait-loop.ts'

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
      [HL, 'run', name, '--', 'sh', '-c', `echo "$$" > "${cache}/${name}.ran"; ${waitForFile(`${cache}/${name}.go`)}`],
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
CI_SLOTS=\${CI_SLOTS:-3} CI_MAX_LOAD=0 CI_POLL=\${CI_POLL:-0.1} CI_LOCK_TIMEOUT=\${CI_LOCK_TIMEOUT:-60} CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "${name}" || exit 1
echo "$$" > "${cache}/${name}.ran"
${inner ? `ci_mutex "$LOCKS" suites touch "${cache}/${name}.inner"` : ''}
${waitForFile(`${cache}/${name}.go`)}
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
${waitForFile(`${cache}/${name}.fold`)}
ci_fold_wait "$RD/results" check
echo idle > "${cache}/${name}.idle"
${waitForFile(`${cache}/${name}.resume`)}
ci_fold_resume "$RD/results" check "$LOCKS"
echo resumed > "${cache}/${name}.resumed"
${waitForFile(`${cache}/${name}.go`)}
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
  // a CI run whose jobs are lists of units, as ci-local.sh's are: it takes a run slot, keeps a run record (runs/<nonce>/jobs, results/) and
  // starts each job as a background subshell with CI_JOBNAME set. A job's unit is one hold of CI's suites slot (ci_mutex; 'quiet' is
  // ci_mutex_all with the quiet group marked, as check's is). A unit writes <name>.<job>.<i>.in, waits for <name>.<job>.<i>.go and
  // writes <name>.<job>.<i>.out; a job that has run all its units leaves its result. <name>.done says the run ended with every result.
  // late: jobs that ask for their first hold only when the test writes <name>.<job>.start (so the order of the asking is the test's)
  // chained: [first, second]: second is not started until first has ended, and is marked idle meanwhile (start_jobs, the Swift pair)
  const yieldRun = (
    name: string,
    jobs: Record<string, string[]>,
    more: Record<string, string> = {},
    chained?: string[],
    late: string[] = [],
  ) => {
    const script = join(cache, `${name}.yield.sh`)
    const units = (j: string) =>
      jobs[j]
        ?.map(
          (k, i) =>
            `${k === 'quiet' ? 'ci_mutex_all' : 'ci_mutex'} "$LOCKS" suites ${k === 'quiet' ? 'quiet_unit' : 'unit'} ${j} ${i + 1}`,
        )
        .join('\n') ?? ''
    const body = Object.keys(jobs)
      .map((j) => {
        const wait =
          chained && chained[1] === j
            ? `${waitForFile(`$RESULTS/${chained[0]}`, { step: 0.1 })}; ci_fold_resume "$RESULTS" ${j} "$LOCKS"`
            : ''
        return `( CI_JOBNAME=${j}\n${late.includes(j) ? waitForFile(`${cache}/${name}.${j}.start`, { keepWhile: 'kill -0 $$' }) : ''}\n${wait}\n${units(j)}\necho "0 1 ok" > "$RESULTS/${j}.part" && mv "$RESULTS/${j}.part" "$RESULTS/${j}" ) &`
      })
      .join('\n')
    writeFileSync(
      script,
      `CI_NONCE="$$-$RANDOM-$(date +%s)"; CI_HELD="" CI_SLOT="" CI_MARKER=""
CI_LOCAL_LIB="${join(here, 'ci-local')}"; CACHE="${cache}"; LOCKS="${locks}"
CI_SLOTS=\${CI_SLOTS:-3} CI_MAX_LOAD=0 CI_POLL=0.1 CI_LOCK_TIMEOUT=\${CI_LOCK_TIMEOUT:-60} CI_LOCK_GRACE=30
. "${LOCKS_SH}"
trap 'ci_release_all' EXIT
ci_acquire_slot "$LOCKS" "${name}" || exit 1
RD="$CACHE/runs/$CI_NONCE"; RESULTS="$RD/results"; mkdir -p "$RESULTS"
printf '%s\\n' ${Object.keys(jobs).join(' ')} > "$RD/jobs"
${chained ? `ci_fold_wait "$RESULTS" ${chained[1]}` : ''}
unit() {
  echo "$1.$2" >> "$CACHE/${name}.order"
  echo in > "$CACHE/${name}.$1.$2.in"
  ${waitForFile(`${cache}/${name}.$1.$2.go`, { keepWhile: 'kill -0 $$' })}
  echo out > "$CACHE/${name}.$1.$2.out"
}
quiet_unit() { ci_quiet_begin "$LOCKS"; unit "$@"; local rc=$?; ci_quiet_end "$LOCKS" $rc; return $rc; }
echo "$$" > "${cache}/${name}.ran"
${body}
wait
echo done > "${cache}/${name}.done"
`,
    )
    const c = spawn('bash', [script], { env: { ...env, ...more } })
    tags.set(c, name)
    const t = track(c)
    return {
      ...t,
      startJob: (j: string) => writeFileSync(join(cache, `${name}.${j}.start`), ''),
      goUnit: (j: string, i: number) => writeFileSync(join(cache, `${name}.${j}.${i}.go`), ''),
      started: (j: string, i: number) => existsSync(join(cache, `${name}.${j}.${i}.in`)),
      finished: (j: string, i: number) => existsSync(join(cache, `${name}.${j}.${i}.out`)),
      order: () =>
        existsSync(join(cache, `${name}.order`))
          ? readFileSync(join(cache, `${name}.order`), 'utf8')
              .trim()
              .split('\n')
          : [],
      result: (j: string) => {
        const d = join(cache, 'runs')
        const run = existsSync(d) ? readdirSync(d)[0] : undefined
        const f = run ? join(d, run, 'results', j) : ''
        return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : null
      },
    }
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
  return { cache, env, locks, until, ran, has, gate, ci, foldRun, yieldRun, alerts, status, queue, fakeHolder }
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

  it('CI that arrives while a gate waits goes behind it, whoever queued first', async () => {
    const m = machine()
    const a = m.ci('runA')
    await m.until(() => m.ran('runA'))
    const g = m.gate('g1')
    await m.until(() => m.queue('suites').length === 1)
    const b = m.ci('runB') // arrives after the gate: not admitted just because CI is on
    await m.until(() => /gates that are queued go before this run/.test(b.err()))
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

  it('a gate goes before a CI run that is queued, though the run came first: the run has not waited behind enough gates yet', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const c = m.ci('runC')
    await m.until(() => m.queue('admit').length === 1)
    const g2 = m.gate('g2') // a gate slot is free and a gate is on: it joins it, ahead of the run that queued before it
    await m.until(() => m.ran('g2'))
    expect(m.ran('runC')).toBe(false)
    g1.go()
    g2.go()
    await m.until(() => m.ran('runC')) // the gates' holds ended, nobody was stopped: now the run
    c.go()
    expect([await g1.done, await g2.done, await c.done]).toEqual([0, 0, 0])
  })

  it('a queued CI run that has waited behind 2 gates (CI_TURN_PASS_MAX) goes next: the gates that come later wait for it, and no hold is stopped', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    await m.until(() => m.ran('g1'))
    const c = m.ci('runC')
    await m.until(() => m.queue('admit').length === 1)
    const g2 = m.gate('g2') // passes the run: 1
    await m.until(() => m.ran('g2'))
    const g3 = m.gate('g3') // both gate slots are busy: it waits for a slot, and passes the run when g1 ends: 2
    await m.until(() => m.queue('suites').length === 1)
    g1.go()
    await m.until(() => m.ran('g3'))
    const g4 = m.gate('g4') // the run has waited behind 2 gates: it goes before this one
    await m.until(() => /CI runs that have waited .* go first/.test(g4.err()))
    await sleep(500) // timing-ok: a negative window, it must not have started
    expect(m.ran('g4')).toBe(false)
    expect(m.ran('runC')).toBe(false) // g2 and g3 hold: they are never stopped
    g2.go()
    g3.go()
    await m.until(() => m.ran('runC'))
    expect(m.ran('g4')).toBe(false)
    c.go()
    await m.until(() => m.ran('g4'))
    g4.go()
    expect([await g1.done, await g2.done, await g3.done, await g4.done, await c.done]).toEqual([0, 0, 0, 0, 0])
  })

  it('a stream of gates cannot starve a queued CI run: it runs after 2 gates have passed it, before the rest of the stream', async () => {
    const m = machine()
    const g1 = m.gate('g1')
    const g2 = m.gate('g2')
    await m.until(() => m.ran('g1') && m.ran('g2'))
    const c = m.ci('runC')
    await m.until(() => m.queue('admit').length === 1)
    const stream = ['g3', 'g4', 'g5', 'g6', 'g7', 'g8']
    for (const n of stream) writeFileSync(join(m.cache, `${n}.go`), '') // each ends as soon as it runs
    const rest: ReturnType<typeof m.gate>[] = []
    for (const [i, n] of stream.entries()) {
      rest.push(m.gate(n)) // one at a time: the order they queue in is the order they are listed in
      await m.until(() => m.queue('suites').length === i + 1)
    }
    g1.go() // two slots free up one after the other: g3 and g4 pass the run
    await m.until(() => m.ran('g3') && m.ran('g4'))
    g2.go()
    await m.until(() => m.ran('runC'))
    const at = (t: string) => statSync(join(m.cache, `${t}.ran`)).mtimeMs
    c.go()
    await Promise.all([g1.done, g2.done, c.done, ...rest.map((r) => r.done)])
    expect(stream.filter((n) => at(n) < at('runC'))).toEqual(['g3', 'g4'])
  })

  it('a class that is on lets a newcomer join when no waiter of the other class goes first', async () => {
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

  // A scheduled run (the nightly, the hostile nightly: CI_NIGHTLY=1) starts only on an empty queue: it leaves the machine to a push run
  // that is queued or holds a run slot (locks.sh, ci_acquire_slot), and to every gate that waits. It never makes a gate wait
  // (ci_turn_ahead), or the three wait for each other: the scheduled run for the push run, the push run for the gates, the gate for the
  // scheduled run.
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
      expect(s.err()).toMatch(/went ahead of a busy queue after \d+ min \(CI_TURN_MAX_S\): a push run is queued/)
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

    // The queue is empty: no gate and no push run waits or holds (a gate that holds or waits, a push run that waits: the turn and the
    // push check above). A push run that HOLDS a slot counts too: before, a scheduled run took the next run slot beside it.
    it('a scheduled run waits while a push run holds a run slot, and goes when it has ended', async () => {
      const m = machine()
      const p = m.ci('runP')
      await m.until(() => m.ran('runP'))
      const s = m.ci('runS', { CI_NIGHTLY: '1' })
      await m.until(() => /a push run is on/.test(s.err()))
      await sleep(500) // timing-ok: a negative window, it must not have started
      expect(m.ran('runS')).toBe(false) // a run slot is free, and it still waits
      p.go()
      expect(await p.done).toBe(0)
      await m.until(() => m.ran('runS'))
      s.go()
      expect(await s.done).toBe(0)
    })

    it('a scheduled run that waits for a push run that holds goes ahead after CI_TURN_MAX_S, loudly', async () => {
      const m = machine()
      const p = m.ci('runP')
      await m.until(() => m.ran('runP'))
      const s = m.ci('runS', { CI_NIGHTLY: '1', CI_TURN_MAX_S: '1', CI_LOCK_TIMEOUT: '1' })
      await m.until(() => m.ran('runS'), 15_000)
      expect(s.err()).toMatch(/a push run is on/)
      expect(s.err()).toMatch(/went ahead of a busy queue after \d+ min \(CI_TURN_MAX_S\): a push run is on/)
      p.go()
      s.go()
      expect([await p.done, await s.done]).toEqual([0, 0])
    })

    it('scheduled runs do not make each other wait (the nightly and the hostile nightly overlap, as before)', async () => {
      const m = machine()
      const a = m.ci('runA', { CI_NIGHTLY: '1' })
      await m.until(() => m.ran('runA'))
      const b = m.ci('runB', { CI_HOSTILE: '1' })
      await m.until(() => m.ran('runB'))
      a.go()
      b.go()
      expect([await a.done, await b.done]).toEqual([0, 0])
    })

    it('a gate that queues after a scheduled run still goes before it: the scheduled run waits for every gate that is queued', async () => {
      const m = machine()
      const p = m.ci('runP')
      await m.until(() => m.ran('runP'))
      const s = m.ci('runS', { CI_NIGHTLY: '1' }) // queues first, behind the push run that holds
      await m.until(() => /a push run is on/.test(s.err()))
      const g = m.gate('g1') // queues after it, and waits for the push run that holds
      await m.until(() => m.queue('suites').length === 1)
      // wait until the scheduled run has looked at the queue with the gate in it: a look that began before the gate queued can still end with
      // the run taking the slot the push run frees (the gate arrived in the middle of that look), and a loaded machine makes that look seconds long
      await m.until(() => /gates that are queued go before this run/.test(s.err()))
      p.go()
      await m.until(() => m.ran('g1')) // the scheduled run did not take the free machine under the gate
      expect(m.ran('runS')).toBe(false)
      expect(s.err()).toMatch(/gates that are queued go before this run|a gate holds the machine/)
      g.go()
      await m.until(() => m.ran('runS'))
      s.go()
      expect([await p.done, await g.done, await s.done]).toEqual([0, 0, 0])
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

  // nGates gates and nCi CI runs started together, each holding 0.3 s: the events of every hold in order ("+G", "-G", "+C", "-C")
  const takeTurns = async (m: ReturnType<typeof machine>, nGates: number, nCi: number) => {
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
    for (let i = 0; i < Math.max(nGates, nCi); i++) {
      if (i < nGates) all.push(mk('G', i))
      if (i < nCi) all.push(mk('C', i))
    }
    expect(await Promise.all(all)).toEqual(Array(nGates + nCi).fill(0))
    const events = readFileSync(log, 'utf8').trim().split('\n')
    let g = 0
    let c = 0
    for (const e of events) {
      if (e === '+G') g++
      if (e === '-G') g--
      if (e === '+C') c++
      if (e === '-C') c--
      expect(g > 0 && c > 0, `overlap at ${e}`).toBe(false)
    }
    return events
  }

  it('never both at once: gates and CI runs started together take turns', async () => {
    const events = await takeTurns(machine(), 5, 5)
    expect(events).toHaveLength(20)
  })

  it('4 gates and 4 CI runs never overlap, and every CI run runs: gates go first, but never past the starvation cap', async () => {
    const events = await takeTurns(machine(), 4, 4)
    expect(events.filter((e) => e === '+G')).toHaveLength(4)
    expect(events.filter((e) => e === '+C')).toHaveLength(4)
    // with a cap of 0 a CI run goes before every gate: the same four and four, and still never together
    const eager = await takeTurns(machine({ CI_TURN_PASS_MAX: '0' }), 4, 4)
    expect(eager.filter((e) => e === '+C')).toHaveLength(4)
    expect(eager.filter((e) => e === '+G')).toHaveLength(4)
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
  describe('a CI run lets the heavy lock go between whole holds when a gate waits, and takes its place back after it', () => {
    const quiet = (ms = 500) => sleep(ms) // timing-ok: a negative window, the gate must not have started
    it('a gate that waits goes at the next boundary: it does not wait for the rest of the run, and the run finishes with every unit run', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      expect(m.ran('g1')).toBe(false) // the unit that is on is never cut short
      run.goUnit('a', 1)
      await m.until(() => m.ran('g1')) // the boundary: the gate has the machine, the job's next hold has not begun
      expect(run.started('a', 2)).toBe(false)
      expect(run.err()).toMatch(/a gate/)
      await quiet()
      expect(run.started('a', 2)).toBe(false) // it waits, it is not killed
      g.go()
      expect(await g.done).toBe(0)
      await m.until(() => run.started('a', 2)) // its place back in line, after the gate
      run.goUnit('a', 2)
      await m.until(() => run.started('a', 3))
      run.goUnit('a', 3)
      expect(await run.done).toBe(0)
      expect(run.order()).toEqual(['a.1', 'a.2', 'a.3'])
      expect([1, 2, 3].every((i) => run.finished('a', i))).toBe(true)
      expect(run.result('a')).toBe('0 1 ok') // the same result as with no gate
    })

    it('with no gate waiting nothing yields: the next unit starts at once', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      run.goUnit('a', 1)
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      expect(run.err()).not.toMatch(/lets go|a gate/)
    })

    it("it never yields inside a quiet (exclusive) group: the gate waits for the whole group, and goes before the job's next hold", async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['quiet', 'unit'] })
      await m.until(() => run.started('a', 1))
      expect(existsSync(join(m.locks, 'quiet-group'))).toBe(true)
      const g = m.gate('g1')
      await m.until(() => /quiet group/.test(g.err()) || /CI runs hold the machine/.test(g.err()))
      await quiet()
      expect(m.ran('g1')).toBe(false)
      expect(run.finished('a', 1)).toBe(false) // still going, and not stopped
      run.goUnit('a', 1)
      await m.until(() => m.ran('g1'))
      expect(run.finished('a', 1)).toBe(true) // the group ran to its end first
      expect(run.started('a', 2)).toBe(false)
      g.go()
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
    })

    it("an exclusive hold that has taken only some of CI's slots lets them go and yields: nothing of it has begun", async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit'], b: ['quiet'] }, {}, undefined, ['b'])
      await m.until(() => run.started('a', 1)) // a holds one of CI's two slots
      run.startJob('b') // now the quiet group asks, behind it
      const slot2 = join(m.locks, 'mutex-suites-2')
      await m.until(() => existsSync(join(slot2, 'owner'))) // the quiet group asked for both, took the free one and waits for the other
      expect(run.started('b', 1)).toBe(false)
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      await m.until(() => !existsSync(join(slot2, 'owner'))) // it let its slot go: nothing of it has begun
      expect(existsSync(join(m.locks, 'quiet-group'))).toBe(false)
      run.goUnit('a', 1)
      await m.until(() => m.ran('g1')) // a's hold ended: the gate goes, the quiet group does not begin
      await quiet()
      expect(run.started('b', 1)).toBe(false)
      g.go()
      await m.until(() => run.started('b', 1)) // after the gate, the whole group
      run.goUnit('b', 1)
      expect(await run.done).toBe(0)
      expect(run.order()).toEqual(['a.1', 'b.1'])
    })

    it('a gate that waits for a starved CI run is no reason to yield: the run goes on, the starved run takes its slot, then the gate', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] }, { CI_SLOTS: '1' })
      await m.until(() => run.started('a', 1))
      const starved = m.ci('r3', { CI_SLOTS: '1', CI_TURN_PASS_MAX: '0' }) // queued for the one run slot, starved at once
      await m.until(() => m.queue('admit').length === 1)
      const g = m.gate('g1') // goes behind the starved run
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('a', 1)
      await m.until(() => run.started('a', 2)) // no yield: it would wait for a gate that waits for the run that waits for it
      expect(m.ran('g1')).toBe(false)
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      await m.until(() => m.ran('r3'))
      expect(m.ran('g1')).toBe(false)
      starved.go()
      expect(await starved.done).toBe(0)
      await m.until(() => m.ran('g1'))
      g.go()
      expect(await g.done).toBe(0)
    })

    it("a job that yields does not hold up another run's exclusive group: its ticket is set aside, and the group goes, so the gate is not waiting for a cycle", async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] })
      const other = m.yieldRun('runB', { b: ['quiet'] }, { CI_TURN_PASS_MAX: '0' }, undefined, ['b']) // never yields: busy until its group is done
      await m.until(() => run.started('a', 1) && m.ran('runB'))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('a', 1) // a asks for its second hold and yields, its ticket the older one
      await m.until(() => /a gate waits for the machine/.test(run.err()))
      other.startJob('b') // the quiet group asks now: it must not wait for the ticket of a job that yields
      await m.until(() => other.started('b', 1))
      expect(run.started('a', 2)).toBe(false)
      expect(m.ran('g1')).toBe(false) // the group is a hold: the gate waits for it
      other.goUnit('b', 1)
      expect(await other.done).toBe(0)
      await m.until(() => m.ran('g1')) // runB is over, runA is between holds
      g.go()
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
    })

    it('the run holds the machine while another of its jobs is in the middle of a hold: the gate waits for that one too, and no more', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit'], b: ['unit'] })
      await m.until(() => run.started('a', 1) && run.started('b', 1))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('a', 1) // a is at its boundary and yields, b is still in a hold
      await quiet()
      expect(m.ran('g1')).toBe(false)
      expect(run.started('a', 2)).toBe(false)
      run.goUnit('b', 1) // b's hold ends and it has no more: the whole run is between holds
      await m.until(() => m.ran('g1'))
      g.go()
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
    })

    it('a job that has not begun, behind another job of its group (the Swift pair), does not hold the run busy', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { desktop: ['unit', 'unit'], mobile: ['unit'] }, {}, ['desktop', 'mobile'])
      await m.until(() => run.started('desktop', 1))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('desktop', 1)
      await m.until(() => m.ran('g1')) // mobile waits behind desktop: idle, not busy
      expect(run.started('desktop', 2)).toBe(false)
      g.go()
      await m.until(() => run.started('desktop', 2))
      run.goUnit('desktop', 2)
      await m.until(() => run.started('mobile', 1))
      run.goUnit('mobile', 1)
      expect(await run.done).toBe(0)
      expect(run.result('mobile')).toBe('0 1 ok')
    })

    it('the cap on gates (CI_TURN_PASS_MAX, 2) bounds how many pass the run: the third waits until the run has ended', async () => {
      const m = machine({ CI_TURN_PASS_MAX: '2' })
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      const gates = ['g1', 'g2', 'g3'].map((n) => ({ n, g: m.gate(n) }))
      await m.until(() => gates.every(({ g }) => /CI runs hold the machine/.test(g.err())))
      run.goUnit('a', 1)
      await m.until(() => gates.filter(({ n }) => m.ran(n)).length === 2) // two passes
      await quiet()
      const passed = gates.filter(({ n }) => m.ran(n))
      const [third] = gates.filter(({ n }) => !m.ran(n))
      expect(third).toBeDefined()
      passed[0]?.g.go() // a gate slot is free, but the run has been passed twice: it holds the turn from now on
      expect(await passed[0]?.g.done).toBe(0)
      await quiet()
      expect(m.ran(third?.n ?? '')).toBe(false)
      expect(run.started('a', 2)).toBe(false) // the run goes on after the gate that still holds: nothing of it is stopped
      passed[1]?.g.go()
      expect(await passed[1]?.g.done).toBe(0)
      await m.until(() => run.started('a', 2))
      await quiet()
      expect(m.ran(third?.n ?? '')).toBe(false) // the run is on again: the third gate waits for it
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      await m.until(() => m.ran(third?.n ?? ''))
      third?.g.go()
      expect(await third?.g.done).toBe(0)
    })

    it('a gate is one pass for the run however many of its jobs yield: two jobs yielding, two gates pass (CI_TURN_PASS_MAX 2), the third waits', async () => {
      const m = machine({ CI_TURN_PASS_MAX: '2' })
      const run = m.yieldRun('runA', { a: ['unit', 'unit'], b: ['unit', 'unit'] })
      await m.until(() => run.started('a', 1) && run.started('b', 1))
      const gates = ['g1', 'g2', 'g3'].map((n) => ({ n, g: m.gate(n) }))
      await m.until(() => gates.every(({ g }) => /CI runs hold the machine/.test(g.err())))
      run.goUnit('a', 1)
      run.goUnit('b', 1) // both jobs are at their boundary and yield
      await m.until(() => gates.filter(({ n }) => m.ran(n)).length === 2) // each gate one pass, not one for each job
      await quiet()
      expect(gates.filter(({ n }) => m.ran(n))).toHaveLength(2)
      for (const { n, g } of gates) if (m.ran(n)) g.go()
      await m.until(() => run.started('a', 2) && run.started('b', 2))
      run.goUnit('a', 2)
      run.goUnit('b', 2)
      expect(await run.done).toBe(0)
      const third = gates.find(({ n }) => !m.ran(n))
      await m.until(() => m.ran(third?.n ?? ''))
      third?.g.go()
    })

    it('a cap of 0 gates never yields: the run goes on, and the gate waits for it', async () => {
      const m = machine({ CI_TURN_PASS_MAX: '0' })
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('a', 1)
      await m.until(() => run.started('a', 2))
      expect(m.ran('g1')).toBe(false)
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      await m.until(() => m.ran('g1'))
      g.go()
    })

    it('the cap in seconds (CI_TURN_PASS_MAX_S) bounds it too: a gate that comes after it has run out waits for the run', async () => {
      const m = machine({ CI_TURN_PASS_MAX_S: '2' })
      const run = m.yieldRun('runA', { a: ['unit', 'unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      const g1 = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g1.err()))
      run.goUnit('a', 1)
      await m.until(() => m.ran('g1')) // within the cap: it passed
      await sleep(2600) // timing-ok: the cap is in real seconds here, the time it runs out
      const g2 = m.gate('g2')
      await m.until(() => /CI runs hold the machine/.test(g2.err()))
      await quiet()
      expect(m.ran('g2')).toBe(false)
      g1.go()
      await m.until(() => run.started('a', 2))
      expect(m.ran('g2')).toBe(false)
      run.goUnit('a', 2)
      await m.until(() => run.started('a', 3))
      run.goUnit('a', 3)
      expect(await run.done).toBe(0)
      await m.until(() => m.ran('g2'))
      g2.go()
    })

    it('with the turns off nothing yields', async () => {
      const m = machine({ CI_TURN: '0' })
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] })
      await m.until(() => run.started('a', 1))
      const g = m.gate('g1')
      await m.until(() => m.ran('g1')) // no turns: the gate does not wait for the run
      run.goUnit('a', 1)
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      g.go()
      expect(run.err()).not.toMatch(/a gate/)
    })

    it('a yield does not run out the lock timeout: the job is not "not tested" for having waited for a gate', async () => {
      const m = machine()
      const run = m.yieldRun('runA', { a: ['unit', 'unit'] }, { CI_LOCK_TIMEOUT: '2' })
      await m.until(() => run.started('a', 1))
      const g = m.gate('g1')
      await m.until(() => /CI runs hold the machine/.test(g.err()))
      run.goUnit('a', 1)
      await m.until(() => m.ran('g1'))
      await sleep(3000) // timing-ok: longer than the lock timeout the job has (2 s)
      g.go()
      await m.until(() => run.started('a', 2))
      run.goUnit('a', 2)
      expect(await run.done).toBe(0)
      expect(run.err()).not.toMatch(/timed out/)
    })
  })

  // The starvation cap on its own: tickets written by hand (living pids), the clock handed in (CI_TURN_NOW), ci_turn_check called directly.
  // No process waits and nothing sleeps. A ticket's name is the second it came: T0 is the CI run's, 1000 s later is the gate's.
  describe('the starvation cap: a CI run waits behind gates until 2 of them have passed it or it has waited 1800 s', () => {
    const T0 = 1_800_000_000
    const stamp = (t: number) => `${t}.000000`
    // a living waiter's ticket: kind ci (admit) or a gate's (suites: push, run or jump)
    // line 7: what the ticket says of itself: a gate's "turn2" (unless old: a gate of the code before the cap), a scheduled run's "sched",
    // a CI run's "caps N S"
    const ticket = (
      m: ReturnType<typeof machine>,
      q: 'admit' | 'suites',
      at: number,
      kind: string,
      extra = '',
      old = false,
    ) => {
      const sleeper = spawn('sleep', ['300'])
      kids.push(sleeper)
      const start = spawnSync('bash', ['-c', `CI_NONCE=t; . "${LOCKS_SH}"; ci_proc_start ${sleeper.pid}`], {
        encoding: 'utf8',
      }).stdout.trim()
      mkdirSync(join(m.cache, 'locks.queue', q), { recursive: true })
      const file = join(m.cache, 'locks.queue', q, `${stamp(at)}.${sleeper.pid}.1`)
      const jump = kind === 'jump' ? 'jump' : ''
      const k = kind === 'jump' ? 'push' : kind
      const l7 = extra || (q === 'suites' && !old ? 'turn2' : '')
      writeFileSync(file, `${sleeper.pid}\n${start}\n${sleeper.pid}-x-1\n${kind}-ticket\n${jump}\n${k}\n${l7}`)
      return file
    }
    const passes = (m: ReturnType<typeof machine>, ...at: number[]) => {
      mkdirSync(join(m.cache, 'locks.queue'), { recursive: true })
      writeFileSync(join(m.cache, 'locks.queue', 'gate-passes'), at.map((t) => `${stamp(t)}\n`).join(''))
    }
    // "<exit>:<what it says>": 1 = this class must wait
    const check = (
      m: ReturnType<typeof machine>,
      cls: 'ci' | 'gate',
      file: string,
      now: number,
      env: Record<string, string> = {},
    ) => {
      const jump = /\n(jump)\n/.test(readFileSync(file, 'utf8')) ? 'jump' : ''
      const r = spawnSync(
        'bash',
        [
          '-c',
          `CI_NONCE=t CI_HELD=; . "${LOCKS_SH}"; ci_turn_check "${m.locks}" ${cls} "${file}" "${jump}"; echo "$?:$CI_TURN_BASE"`,
        ],
        { env: { ...m.env, CI_TURN_NOW: String(now), ...env }, encoding: 'utf8' },
      )
      return r.stdout.trim()
    }

    it('before the cap a queued gate goes before the CI run, and a CI run does not hold a gate back', () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci')
      const g = ticket(m, 'suites', T0 + 10, 'push')
      expect(check(m, 'ci', c, T0 + 100)).toMatch(/^1:gates that are queued go before this run \(pid \d+ /)
      expect(check(m, 'gate', g, T0 + 100)).toBe('0:')
      // the same, whichever of the two queued first
      const g0 = ticket(m, 'suites', T0 - 50, 'push')
      expect(check(m, 'ci', c, T0 + 100)).toMatch(/^1:gates that are queued/)
      expect(check(m, 'gate', g0, T0 + 100)).toBe('0:')
    })

    it('by time: at CI_TURN_PASS_MAX_S (1800 s) the CI run goes next, and a gate waits for it', () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci')
      const g = ticket(m, 'suites', T0 + 10, 'push')
      expect(check(m, 'ci', c, T0 + 1799)).toMatch(/^1:/)
      expect(check(m, 'gate', g, T0 + 1799)).toBe('0:')
      expect(check(m, 'ci', c, T0 + 1800)).toBe('0:')
      expect(check(m, 'gate', g, T0 + 1800)).toMatch(/^1:CI runs that have waited .* go first \(pid \d+ /)
      // settable
      expect(check(m, 'ci', c, T0 + 59, { CI_TURN_PASS_MAX_S: '60' })).toMatch(/^1:/)
      expect(check(m, 'ci', c, T0 + 60, { CI_TURN_PASS_MAX_S: '60' })).toBe('0:')
    })

    it('by count: after 2 gates have passed it (CI_TURN_PASS_MAX) the CI run goes next; a pass from before it queued does not count', () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci')
      const g = ticket(m, 'suites', T0 + 10, 'push')
      passes(m, T0 - 5, T0 + 5) // one pass counts
      expect(check(m, 'ci', c, T0 + 100)).toMatch(/^1:/)
      expect(check(m, 'gate', g, T0 + 100)).toBe('0:')
      passes(m, T0 - 5, T0 + 5, T0 + 6) // two count
      expect(check(m, 'ci', c, T0 + 100)).toBe('0:')
      expect(check(m, 'gate', g, T0 + 100)).toMatch(/^1:CI runs that have waited/)
      passes(m, T0 + 5, T0 + 6)
      expect(check(m, 'ci', c, T0 + 100, { CI_TURN_PASS_MAX: '3' })).toMatch(/^1:/) // settable
      expect(check(m, 'ci', c, T0 + 100, { CI_TURN_PASS_MAX: '1' })).toBe('0:')
    })

    it('a checked --red-main jump gate still goes before any CI run, a scheduled run is never starved and never makes a gate wait', () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci')
      const j = ticket(m, 'suites', T0 + 10, 'jump')
      passes(m, T0 + 5, T0 + 6)
      expect(check(m, 'gate', j, T0 + 5000)).toBe('0:') // before a starved run
      expect(check(m, 'ci', c, T0 + 5000)).toMatch(/^1:gates that are queued go before this run \(pid \d+ /) // and it waits for the jump gate
      const m2 = machine()
      const s = ticket(m2, 'admit', T0, 'ci', 'sched')
      const g = ticket(m2, 'suites', T0 + 10, 'push')
      passes(m2, T0 + 5, T0 + 6)
      expect(check(m2, 'ci', s, T0 + 5000)).toMatch(/^1:gates that are queued/) // never starved: it waits for every gate
      expect(check(m2, 'gate', g, T0 + 5000)).toBe('0:') // and a gate never waits for it
    })

    it('with no record of passes yet nothing is said on stderr, and a cap of 0 starves a run at once', () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci')
      const g = ticket(m, 'suites', T0 + 10, 'push')
      const err = (cls: 'ci' | 'gate', f: string, env: Record<string, string> = {}) => {
        const jump = ''
        return spawnSync(
          'bash',
          ['-c', `CI_NONCE=t CI_HELD=; . "${LOCKS_SH}"; ci_turn_check "${m.locks}" ${cls} "${f}" "${jump}"`],
          { env: { ...m.env, CI_TURN_NOW: String(T0 + 5), ...env }, encoding: 'utf8' },
        ).stderr
      }
      expect(err('ci', c)).toBe('')
      expect(err('gate', g)).toBe('')
      expect(check(m, 'ci', c, T0 + 5, { CI_TURN_PASS_MAX: '0' })).toBe('0:')
      expect(check(m, 'gate', g, T0 + 5, { CI_TURN_PASS_MAX: '0' })).toMatch(/^1:CI runs that have waited/)
    })

    it('a gate that takes its slot is one pass for every CI run that waits; the record holds nothing once none waits', () => {
      const m = machine()
      const file = join(m.cache, 'locks.queue', 'gate-passes')
      const run = (now: number) =>
        spawnSync('bash', ['-c', `CI_NONCE=t CI_HELD=; . "${LOCKS_SH}"; ci_turn_pass "${m.locks}"`], {
          env: { ...m.env, CI_TURN_NOW: String(now) },
          encoding: 'utf8',
        })
      run(T0 + 1) // nobody waits: nothing to count
      expect(existsSync(file)).toBe(false)
      ticket(m, 'admit', T0 + 10, 'ci')
      run(T0 + 20)
      run(T0 + 30)
      expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([stamp(T0 + 20), stamp(T0 + 30)])
      rmSync(join(m.cache, 'locks.queue', 'admit'), { recursive: true })
      run(T0 + 40) // the queue is empty again: the record goes
      expect(existsSync(file)).toBe(false)
    })

    it('a CI ticket that is still being written (.part) counts as queued: the pass is not lost', () => {
      const m = machine()
      mkdirSync(join(m.cache, 'locks.queue', 'admit'), { recursive: true })
      writeFileSync(join(m.cache, 'locks.queue', 'admit', `${stamp(T0)}.123.1.part`), '')
      spawnSync('bash', ['-c', `CI_NONCE=t CI_HELD=; . "${LOCKS_SH}"; ci_turn_pass "${m.locks}"`], {
        env: { ...m.env, CI_TURN_NOW: String(T0 + 5) },
      })
      expect(readFileSync(join(m.cache, 'locks.queue', 'gate-passes'), 'utf8')).toBe(`${stamp(T0 + 5)}\n`)
    })

    it("a CI run's own caps (line 7 of its ticket) decide, whatever the environment of the one that looks", () => {
      const m = machine()
      const c = ticket(m, 'admit', T0, 'ci', 'caps 1 100')
      const g = ticket(m, 'suites', T0 + 10, 'push')
      passes(m, T0 + 5)
      // the gate's environment says 2 passes and 1800 s; the run asked for 1 and 100: both read the run's
      expect(check(m, 'ci', c, T0 + 50, { CI_TURN_PASS_MAX: '2' })).toBe('0:')
      expect(check(m, 'gate', g, T0 + 50, { CI_TURN_PASS_MAX: '2' })).toMatch(/^1:CI runs that have waited/)
      passes(m)
      expect(check(m, 'ci', c, T0 + 99)).toMatch(/^1:/)
      expect(check(m, 'ci', c, T0 + 100, { CI_TURN_PASS_MAX_S: '1800' })).toBe('0:')
      expect(check(m, 'gate', g, T0 + 100, { CI_TURN_PASS_MAX_S: '1800' })).toMatch(/^1:/)
    })

    it('a gate of the code before the cap (no turn2) is waited for only if it queued before the CI run, so neither waits for the other', () => {
      const m = machine()
      ticket(m, 'suites', T0 - 10, 'push', '', true)
      const c = ticket(m, 'admit', T0, 'ci')
      ticket(m, 'suites', T0 + 10, 'push', '', true)
      const m2 = machine()
      const c2 = ticket(m2, 'admit', T0, 'ci')
      ticket(m2, 'suites', T0 + 10, 'push', '', true)
      expect(check(m, 'ci', c, T0 + 100)).toMatch(
        /^1:gates that are queued go before this run \(pid \d+ \(push-ticket\)\)$/,
      ) // one: the older one
      expect(check(m2, 'ci', c2, T0 + 100)).toBe('0:') // the older code's gate that came later waits for the run, as it always did
    })
  })
})
