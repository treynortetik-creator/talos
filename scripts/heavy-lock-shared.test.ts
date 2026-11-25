// The heavy lock shared across Titan's WSL distros (scripts/ci-local/locks.sh, CI_SHARED_LOCK): each "distro" here is a cache of
// its own (its own locks, as Ubuntu's and talos-ci's are), and the two share one lock file, as /mnt/wsl is shared. The flock
// on it serialises their heavy runs; it goes with the holder (killed or done), never with what the holder's command left behind.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { timeFactor } from '../packages/testkit/src/time-factor.ts'
import { waitForFile } from './wait-loop.ts'

const here = dirname(fileURLToPath(import.meta.url))
const HL = join(here, 'heavy-lock.sh')
const F = timeFactor()
vi.setConfig({ testTimeout: 60_000 * F, hookTimeout: 60_000 * F })
const hasFlock = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0
// every sleep this file starts has this odd length, so the cleanup stops this file's sleeps and nothing else on the machine
const NAP = '317.17'

const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) if (k.pid && k.exitCode === null) spawnSync('kill', ['-KILL', String(k.pid)])
  spawnSync('pkill', ['-KILL', '-f', `sleep ${NAP}`])
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-shared-'))
  dirs.push(d)
  return d
}
const exited = (c: ChildProcess) =>
  new Promise<number>((r) => (c.exitCode !== null ? r(c.exitCode) : c.once('exit', (code) => r(code ?? -1))))

/** A "distro": its own cache and locks; every one made by one world() shares the world's lock file. */
function world(shared = true) {
  const root = tmp()
  const file = join(root, 'shared-suites.lock')
  const marks = join(root, 'marks')
  const distro = () => {
    const cache = tmp()
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: cache,
      TALOS_CI_CACHE: cache,
      HEAVY_LOCK_POLL: '0.1',
      TALOS_HEAVY_GUARD: join(cache, 'no-guard'),
      HEAVY_LOCK_TIMEOUT: String(30 * F),
      ...(shared ? { CI_SHARED_LOCK: file } : {}),
    }
    const run = (name: string, script: string, extra: Record<string, string> = {}) => {
      const c = spawn('bash', [HL, 'run', name, '--', 'bash', '-c', script], {
        env: { ...env, ...extra },
        stdio: 'ignore',
      })
      kids.push(c)
      return c
    }
    return { env, run }
  }
  // each step appends "<name> start|end" to one file, so the order is the test's evidence
  const mark = (name: string, body: string) =>
    `echo "${name} start" >> "${marks}"; ${body}; echo "${name} end" >> "${marks}"`
  const lines = () => (existsSync(marks) ? readFileSync(marks, 'utf8').trim().split('\n') : [])
  const seen = (l: string) => vi.waitUntil(() => lines().includes(l), { timeout: 20_000 * F, interval: 25 })
  return { root, file, distro, mark, lines, seen, marks }
}

describe.skipIf(!hasFlock)('the heavy lock shared across WSL distros (CI_SHARED_LOCK)', () => {
  it('two distros, each with its own lock: the second runs only after the first, never beside it', async () => {
    const w = world()
    const a = w.distro().run('a', w.mark('a', 'sleep 1.5'))
    await w.seen('a start')
    const b = w.distro().run('b', w.mark('b', 'true'))
    expect(await exited(a)).toBe(0)
    expect(await exited(b)).toBe(0)
    expect(w.lines()).toEqual(['a start', 'a end', 'b start', 'b end'])
  })

  it('a waiter says whom it waited behind and for how long, in one line the shadow comparison reads', async () => {
    const w = world()
    const release = join(w.root, 'release')
    // a holds until the test says so: no race with how fast b reaches the lock
    const a = w.distro().run('request-hestia', w.mark('a', waitForFile(release, { step: 0.1 })))
    await w.seen('a start')
    const bd = w.distro()
    const b = spawn('bash', [HL, 'run', 'part', '--', 'true'], { env: bd.env, stdio: ['ignore', 'ignore', 'pipe'] })
    kids.push(b)
    let err = ''
    b.stderr?.on('data', (d) => {
      err += d
    })
    await vi.waitUntil(() => err.includes('which the other WSL distro holds'), { timeout: 20_000 * F, interval: 25 })
    writeFileSync(release, '')
    expect(await exited(a)).toBe(0)
    expect(await exited(b)).toBe(0)
    expect(err).toContain('holder: request-hestia: bash -c')
    expect(err).toMatch(/waited \d+s for the heavy lock shared across WSL distros, behind: request-hestia: bash -c/)
    // the holder clears its name when it lets go: a later holder that writes none is "unknown", never this one
    expect(readFileSync(`${w.file}.holder`, 'utf8')).toBe('')
  })

  it('a waiting CI run goes before a waiting request, whichever asked first; the holder is not stopped', async () => {
    const w = world()
    const release = join(w.root, 'release')
    const a = w.distro().run('request-a', w.mark('a', waitForFile(release, { step: 0.1 })))
    await w.seen('a start')
    // a request asks first...
    const b = w.distro().run('request-b', w.mark('b', 'true'))
    await new Promise((r) => setTimeout(r, 1500))
    // ...then a CI run (a ci-local job: ci_mutex with no CI_MUTEX_WHAT), in another distro's cache
    const cd = w.distro()
    const LOCKS_SH = join(here, 'ci-local/locks.sh')
    const ciScript = `CI_NONCE=ci$$ CI_POLL=0.1 CI_LOCK_TIMEOUT=${30 * F} CI_SLOT=1; . "${LOCKS_SH}"; ci_mutex "${cd.env.TALOS_CI_CACHE}/locks" suites bash -c '${w.mark('ci', 'true')}'`
    const ci = spawn('bash', ['-c', ciScript], { env: { ...cd.env, CI_SHARED_LOCK: w.file }, stdio: 'ignore' })
    kids.push(ci)
    await vi.waitUntil(() => readdirSync(w.root).some((n) => n.startsWith('shared-suites.lock.ci.')), {
      timeout: 20_000 * F,
      interval: 25,
    })
    writeFileSync(release, '')
    expect(await exited(a)).toBe(0)
    expect(await exited(ci)).toBe(0)
    expect(await exited(b)).toBe(0)
    expect(w.lines()).toEqual(['a start', 'a end', 'ci start', 'ci end', 'b start', 'b end'])
    // the CI waiter's marker is gone once it has the lock
    expect(readdirSync(w.root).filter((n) => n.startsWith('shared-suites.lock.ci.'))).toEqual([])
  })

  it('a part queued behind the other distro tells its main shell what it waits for, since when, and stops once it has the lock', async () => {
    const w = world()
    const release = join(w.root, 'release')
    const a = w.distro().run('request-a', w.mark('a', waitForFile(release, { step: 0.1 })))
    await w.seen('a start')
    const cd = w.distro()
    const beat = join(w.root, 'lockwait') // the file the part's job writes (CI_LOCKWAIT_FILE): ci-local.sh's main shell posts from it
    const LOCKS_SH = join(here, 'ci-local/locks.sh')
    const ciScript = `CI_NONCE=ci$$ CI_POLL=0.1 CI_LOCK_TIMEOUT=${30 * F} CI_SLOT=1 CI_LOCKWAIT_FILE="${beat}"; . "${LOCKS_SH}"; ci_mutex "${cd.env.TALOS_CI_CACHE}/locks" suites bash -c '${w.mark('ci', 'true')}'`
    const ci = spawn('bash', ['-c', ciScript], { env: { ...cd.env, CI_SHARED_LOCK: w.file }, stdio: 'ignore' })
    kids.push(ci)
    await vi.waitUntil(
      () => existsSync(beat) && readFileSync(beat, 'utf8').includes('which the other WSL distro holds'),
      { timeout: 20_000 * F, interval: 25 },
    )
    const [since, last, what] = readFileSync(beat, 'utf8').trim().split('\t') // since, the last beat (epoch seconds), what it waits for
    expect(Number(since)).toBeGreaterThan(1_700_000_000)
    expect(Number(last)).toBeGreaterThanOrEqual(Number(since))
    expect(what).toBe('the heavy lock, which the other WSL distro holds')
    writeFileSync(release, '')
    expect(await exited(a)).toBe(0)
    expect(await exited(ci)).toBe(0)
    expect(existsSync(beat)).toBe(false) // the lock is had: no longer a wait
  })

  it('a fresh CI marker holds a request back even with the lock free; once it goes stale the request goes', async () => {
    const w = world()
    writeFileSync(`${w.file}.ci.handmade`, '') // a CI run waiting, as far as the request can tell
    const t0 = Date.now()
    const b = w.distro().run('request-b', w.mark('b', 'true'), { CI_SHARED_CI_FRESH: '4' })
    await new Promise((r) => setTimeout(r, 1500))
    expect(w.lines()).not.toContain('b start') // the lock is free, and still the request waits
    expect(await exited(b)).toBe(0)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2500) // it went only once the marker was old (4 s, counted in whole seconds)
  })

  it('a CI run queued behind another CI run in its own distro is marked while it waits there, not only at the flock', async () => {
    const w = world()
    const cd = w.distro() // one distro, two CI runs
    const LOCKS_SH = join(here, 'ci-local/locks.sh')
    const release = join(w.root, 'release')
    const ciRun = (label: string, body: string) => {
      const s = `CI_NONCE=${label}$$ CI_POLL=0.1 CI_LOCK_TIMEOUT=${30 * F} CI_SLOT=1; . "${LOCKS_SH}"; ci_mutex "${cd.env.TALOS_CI_CACHE}/locks" suites bash -c '${w.mark(label, body)}'`
      const c = spawn('bash', ['-c', s], { env: { ...cd.env, CI_SHARED_LOCK: w.file }, stdio: 'ignore' })
      kids.push(c)
      return c
    }
    const one = ciRun('ci1', waitForFile(release, { step: 0.1 }))
    await w.seen('ci1 start')
    const two = ciRun('ci2', 'true')
    // ci2 waits for its own distro's mutex, not yet at the flock: its marker is there already
    await vi.waitUntil(() => readdirSync(w.root).some((n) => n.startsWith('shared-suites.lock.ci.')), {
      timeout: 20_000 * F,
      interval: 25,
    })
    writeFileSync(release, '')
    expect(await exited(one)).toBe(0)
    expect(await exited(two)).toBe(0)
    expect(readdirSync(w.root).filter((n) => n.startsWith('shared-suites.lock.ci.'))).toEqual([])
  })

  it("a CI waiter's marker that nobody touches any more (a killed waiter) stops holding requests back", async () => {
    const w = world()
    writeFileSync(`${w.file}.ci.dead`, '')
    spawnSync('touch', ['-d', '2 minutes ago', `${w.file}.ci.dead`])
    const b = w.distro().run('request-b', w.mark('b', 'true'), { HEAVY_LOCK_TIMEOUT: String(10 * F) })
    expect(await exited(b)).toBe(0)
  })

  it('a holder killed outright frees it: the kernel drops the flock with its holder', async () => {
    const w = world()
    const a = w.distro().run('a', w.mark('a', `sleep ${NAP}`))
    await w.seen('a start')
    const b = w.distro().run('b', w.mark('b', 'true'))
    await new Promise((r) => setTimeout(r, 800))
    expect(w.lines()).not.toContain('b start')
    spawnSync('kill', ['-KILL', String(a.pid)])
    expect(await exited(b)).toBe(0)
    expect(w.lines()).toContain('b end')
  })

  it("what the holder's command leaves running does not keep it: a server started in the background is no holder", async () => {
    const w = world()
    const pidFile = join(w.root, 'server.pid')
    const a = w.distro().run('a', w.mark('a', `sleep ${NAP} >/dev/null 2>&1 & echo $! > "${pidFile}"`))
    expect(await exited(a)).toBe(0)
    const server = Number(readFileSync(pidFile, 'utf8').trim())
    expect(spawnSync('kill', ['-0', String(server)]).status).toBe(0) // still running: the case under test
    const b = w.distro().run('b', w.mark('b', 'true'), { HEAVY_LOCK_TIMEOUT: String(10 * F) })
    expect(await exited(b)).toBe(0)
    spawnSync('kill', ['-KILL', String(server)])
  })

  it("a run inside the holder (a gate's tests, a run inside a CI job) passes straight through, with another distro's locks", async () => {
    const w = world()
    const inner = w.distro()
    // the outer holder runs heavy-lock.sh again with the other distro's cache: the marker lets it through instead of waiting
    // on its own parent's flock
    const innerCmd = `TALOS_CI_CACHE=${inner.env.TALOS_CI_CACHE} HOME=${inner.env.HOME} bash ${HL} run inner -- bash -c 'echo inner >> ${w.marks}'`
    const a = w.distro().run('a', w.mark('a', innerCmd))
    expect(await exited(a)).toBe(0)
    expect(w.lines()).toEqual(['a start', 'inner', 'a end'])
  })

  it("not had in time: the waiter gives up (exit 75), runs nothing, and lets go of its own distro's lock", async () => {
    const w = world()
    const a = w.distro().run('a', w.mark('a', `sleep ${NAP}`))
    await w.seen('a start')
    const bd = w.distro()
    const b = bd.run('b', w.mark('b', 'true'), { HEAVY_LOCK_TIMEOUT: '2' })
    expect(await exited(b)).toBe(75)
    expect(w.lines()).not.toContain('b start')
    // b's own mutex is free again: once the other side is done, its distro runs at once
    spawnSync('kill', ['-KILL', String(a.pid)])
    const c = bd.run('c', w.mark('c', 'true'), { HEAVY_LOCK_TIMEOUT: String(10 * F) })
    expect(await exited(c)).toBe(0)
  })

  it('without CI_SHARED_LOCK (a Mac, another Linux box, the default): two distros do not wait on each other', async () => {
    const w = world(false)
    w.distro().run('a', w.mark('a', `sleep ${NAP}`))
    await w.seen('a start')
    const b = w.distro().run('b', w.mark('b', 'true'))
    expect(await exited(b)).toBe(0) // while a still holds its own distro's lock
    expect(w.lines()).toEqual(['a start', 'b start', 'b end'])
    expect(existsSync(w.file)).toBe(false)
  })
})
