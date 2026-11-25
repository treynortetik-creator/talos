// A test run must leave no process behind: when it ends, the run's own processes that name its folder (orphaned, or below the
// runner) are printed and fail the run; one that is someone else's, or only has a similar path, is printed or ignored and does not.
// Nothing is signalled (run-tmp.ts).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { namesFolder, type RunProcess, scanRun, startRunTmp } from '../src/run-tmp.ts'
import { t } from '../src/time-factor.ts'

const tmpBefore = process.env.TMPDIR
const pathBefore = process.env.PATH
let outer = ''
const kept: number[] = []
/** Records stand-in pids for the end of the test; gives them back. */
const keep = (...pids: number[]) => {
  kept.push(...pids)
  return pids
}

beforeEach(() => {
  outer = mkdtempSync(join(tmpdir(), 'leftovers-outer-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  process.env.PATH = pathBefore
  if (tmpBefore === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = tmpBefore
  // the pids this test recorded as its own stand-ins, and no others
  for (const pid of kept.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already stopped
    }
  }
  rmSync(outer, { recursive: true, force: true })
})

/** Everything that names this test's `outer` folder, the run's own or not. */
function everyone(): RunProcess[] {
  return [outer, `/elsewhere${outer}`].flatMap((d) => {
    const s = scanRun(d)
    return s ? [...s.owned, ...s.named] : []
  })
}

// a stand-in ends by itself after ten minutes (3,000 turns), whatever happens to the test
const LOOP = 'n=0; while [ $n -lt 3000 ]; do sleep 0.2; n=$((n + 1)); done'

/** A child of the test process (so below the runner) with `path` in its command line. */
function child(path: string): number {
  const c = spawn('sh', ['-c', LOOP, 'sh', path], { detached: true, stdio: 'ignore' })
  c.unref()
  if (c.pid === undefined) throw new Error('did not start')
  keep(c.pid)
  return c.pid
}

/** An orphan running `argv`: its parent exits at once, so init has it. Gives its pid. */
function orphanOf(...argv: string[]): number {
  const r = spawnSync('sh', ['-c', '"$@" >/dev/null 2>&1 </dev/null & echo $!', 'sh', ...argv], { encoding: 'utf8' })
  const pid = Number(r.stdout.trim())
  keep(pid)
  return pid
}
const orphan = (path: string) => orphanOf('sh', '-c', LOOP, 'sh', path)

/**
 * Someone else's process: a live parent (an orphan itself, so not below the runner, and with no path in its own command line)
 * with a child that has `path` in its. Gives the parent's pid; the child is found by its path.
 */
function foreign(path: string, body = LOOP): number {
  const r = spawnSync(
    'sh',
    ['-c', 'P="$1" sh -c \'sh -c "$0" sh "$P"; :\' "$2" >/dev/null 2>&1 </dev/null & echo $!', 'sh', path, body],
    { encoding: 'utf8' },
  )
  return keep(Number(r.stdout.trim()))[0]
}

/** Whether `pid` still runs (a stopped child waiting to be reaped is not running). */
function running(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return stat !== '' && !stat.startsWith('Z')
}

/** Waits until the stand-ins have started (a started one shows in the process list). */
const started = (n: number) => vi.waitUntil(() => everyone().length >= n, { timeout: t(10_000), interval: 25 })

/** A run folder under `outer`, as startRunTmp makes it, with a short grace for its leftovers (the default is 10 s). */
function startRun(graceMs = 100) {
  process.env.TMPDIR = outer
  return startRunTmp('leftovers-run-', { graceMs })
}

const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

describe("the run's own processes", () => {
  it('a child of the runner is printed and fails the run, and is not signalled', () => {
    const run = startRun()
    const pid = child(join(run.dir, 'gate.go'))
    const err = quiet()
    expect(running(pid)).toBe(true)

    let message = ''
    try {
      run.end()
    } catch (e) {
      message = String(e)
    }
    // the folder is `<run>`, so the part of the line that names the test is what is left after the cut
    expect(message).toMatch(new RegExp(`left running by this test run.*pid ${pid} sh -c.*sh <run>/gate\\.go`))
    expect(message.split(run.dir)).toHaveLength(2) // the folder is named once, in the head of the message

    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain(
      `left running by this test run: pid ${pid} sh -c`,
    )
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('sh <run>/gate.go')
    expect(running(pid)).toBe(true) // it is named, never stopped
    expect(existsSync(run.dir)).toBe(false) // the folder is still removed
    expect(process.env.TMPDIR).toBe(outer) // and the run's TMPDIR is given back
  })

  it('an orphan (parent 1) is printed and fails the run', async () => {
    const run = startRun()
    const pid = orphan(join(run.dir, 'gate.go'))
    quiet()
    await started(1)
    expect(scanRun(run.dir)?.owned.map((p) => p.pid)).toEqual([pid])
    expect(() => run.end()).toThrow(`pid ${pid} sh -c`)
  })

  it('so is a process below an orphan that names the folder, and the orphan', async () => {
    const run = startRun()
    const path = join(run.dir, 'gate.go')
    // an orphan that names the folder and has a child that does too
    const top = orphanOf('sh', '-c', 'sh -c "$0" sh "$1"; :', LOOP, path)
    quiet()
    await started(2)
    const owned = scanRun(run.dir)?.owned ?? []
    keep(...owned.map((p) => p.pid)) // the child too
    expect(owned.map((p) => p.pid)).toContain(top)
    expect(owned).toHaveLength(2)
    expect(() => run.end()).toThrow('2 process(es)')
  })

  it('is not failed by one that exits within the grace, and the default grace is longer than 2 s', () => {
    process.env.TMPDIR = outer
    const run = startRunTmp('leftovers-run-') // the default grace
    const c = spawn('sh', ['-c', 'sleep 3; :', 'sh', join(run.dir, 'x')], { stdio: 'ignore' })
    expect(c.pid).toBeDefined()
    expect(() => run.end()).not.toThrow()
    expect(existsSync(run.dir)).toBe(false)
  })

  it('also finds one that names the folder by the path the disk resolves it to', () => {
    const run = startRun()
    const real = spawnSync('sh', ['-c', 'cd "$1" && pwd -P', 'sh', run.dir], { encoding: 'utf8' }).stdout.trim()
    const pid = child(join(real, 'gate.go'))
    quiet()
    expect(scanRun(run.dir)?.owned.map((p) => p.pid)).toEqual([pid])
    expect(() => run.end()).toThrow('left running')
  })
})

describe("someone else's process that names the folder", () => {
  it("an orphan that is an agent's or a person's (a log read with tail, a shell snapshot, an app) is named, not failed", async () => {
    const run = startRun()
    writeFileSync(join(run.dir, 'log'), '')
    const pids = [
      orphanOf('tail', '-f', join(run.dir, 'log')),
      orphanOf('sh', '-c', LOOP, 'sh', '/home/alex/.claude/shell-snapshots/s.sh', join(run.dir, 'x')),
      orphanOf('sh', '-c', LOOP, 'sh', '/Applications/Editor.app/Contents/MacOS/e', join(run.dir, 'y')),
    ]
    await started(3)
    const scan = scanRun(run.dir)
    expect(scan?.owned).toEqual([])
    expect(scan?.named.map((p) => p.pid).sort()).toEqual([...pids].sort())
    const err = quiet()
    expect(() => run.end()).not.toThrow()
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('named by this test run, not its own: pid')
  })

  it('a live child of an unrelated parent is printed as named and does not fail the run', async () => {
    const run = startRun()
    const parent = foreign(join(run.dir, 'log'))
    await started(1)
    const named = scanRun(run.dir)?.named ?? []
    expect(named).toHaveLength(1)
    const kid = named[0].pid
    keep(kid) // the parent is the test's own: foreign() recorded it
    const err = quiet()

    expect(() => run.end()).not.toThrow()

    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain(
      `named by this test run, not its own: pid ${kid} sh -c`,
    )
    expect(running(kid)).toBe(true)
    expect(running(parent)).toBe(true)
    expect(existsSync(run.dir)).toBe(false)
  })

  it('is not waited for: a run with only such a process ends without the grace', async () => {
    const run = startRun()
    foreign(join(run.dir, 'log'))
    await started(1)
    keep(...(scanRun(run.dir)?.named ?? []).map((p) => p.pid))
    quiet()
    const t0 = Date.now()
    run.end()
    expect(Date.now() - t0).toBeLessThan(t(5_000)) // the grace is 10 s: it was not paid
  })
})

describe('a process that only has a similar path', () => {
  it('another run, and the same name with more after it, are not touched', async () => {
    const run = startRun()
    const other = join(outer, 'leftovers-run-OTHER')
    mkdirSync(other)
    const pids = [
      child(join(other, 'gate.go')),
      child(`${run.dir}X/gate.go`),
      child(`${run.dir}.ran`),
      child(`/elsewhere${run.dir}/gate.go`),
    ]
    await started(3) // the fourth has /elsewhere before the folder: it is not found by it

    expect(scanRun(run.dir)).toEqual({ owned: [], named: [] })
    expect(() => run.end()).not.toThrow()

    for (const pid of pids) expect(running(pid)).toBe(true)
  })
})

describe('never the test process or the processes above it, nor pid 1', () => {
  it('a process and its parent both name the folder, and neither is found when it is the one looking', () => {
    const run = startRun()
    const probe = pathToFileURL(join(import.meta.dirname, '../src/run-tmp.ts')).href
    const code = `import(${JSON.stringify(probe)}).then((m) => console.log(JSON.stringify(m.scanRun(${JSON.stringify(run.dir)}))))`
    // sh (names the folder) > node (names it) > the look
    const r = spawnSync(
      'sh',
      ['-c', `${JSON.stringify(process.execPath)} -e "$1" "$2"; :`, 'sh', code, join(run.dir, 'x')],
      {
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(r.stdout)).toEqual({ owned: [], named: [] })
    run.end()
  })

  it('pid 1 is never listed, whatever it is called', () => {
    const init = spawnSync('ps', ['-o', 'command=', '-p', '1'], { encoding: 'utf8' }).stdout.trim().split(' ')[0]
    const s = scanRun(init)
    expect([...(s?.owned ?? []), ...(s?.named ?? [])].some((p) => p.pid <= 1)).toBe(false)
  })
})

describe('when the process list cannot be read', () => {
  /** A folder first on the PATH with a `ps` that fails; `again` makes it work from its second call. */
  function fakePs(again: boolean) {
    const bin = join(outer, 'bin')
    mkdirSync(bin)
    const real = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim()
    const mark = join(outer, 'ps-called')
    writeFileSync(
      join(bin, 'ps'),
      `#!/bin/sh\n${again ? `[ -e "${mark}" ] && { printf %s "$LC_ALL" > "${join(outer, 'lc')}"; exec ${real} "$@"; }\n: > "${mark}"\n` : ''}echo "ps: boom" >&2\nexit 1\n`,
    )
    chmodSync(join(bin, 'ps'), 0o755)
    process.env.PATH = `${bin}:${pathBefore}`
  }

  it('says so and passes, never "nothing left" in silence', () => {
    const run = startRun()
    const pid = child(join(run.dir, 'gate.go'))
    const err = quiet()
    fakePs(false)
    expect(() => run.end()).not.toThrow()
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('leftovers of this test run')
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('were not checked')
    process.env.PATH = pathBefore
    expect(running(pid)).toBe(true) // nothing was done on a guess
  })

  it('asks once more first: a ps that fails once and then works still finds the leftover', () => {
    const run = startRun()
    child(join(run.dir, 'gate.go'))
    quiet()
    fakePs(true)
    expect(() => run.end()).toThrow('left running')
    expect(readFileSync(join(outer, 'lc'), 'utf8')).toBe('C') // ps is asked in the C locale
  })
})

describe('a run started inside another run', () => {
  it('does not take the folder of the run whose TMPDIR it inherited', () => {
    process.env.TMPDIR = outer
    const outerRun = startRunTmp('leftovers-run-')
    const inner = startRunTmp('leftovers-run-') // TMPDIR is now outerRun's folder
    expect(inner.dir).not.toBe(outerRun.dir)
    inner.end()
    expect(existsSync(outerRun.dir)).toBe(true) // the outer run's folder is still there
    outerRun.end()
  })

  it('takes it when told to adopt one made for it (the bridge)', () => {
    const made = mkdtempSync(join(outer, 'leftovers-run-'))
    process.env.TMPDIR = made
    const run = startRunTmp('leftovers-run-', { adopt: true })
    expect(run.dir).toBe(made)
    run.end()
    expect(existsSync(made)).toBe(false)
  })
})

describe('namesFolder', () => {
  const dir = '/var/folders/x/T/talos-vitest-run-abc'
  it('takes the exact path, alone or with a path under it', () => {
    expect(namesFolder(`sh -c echo ran > ${dir}/gate.ran`, dir)).toBe(true)
    expect(namesFolder(`sh -c "x" "${dir}"`, dir)).toBe(true)
    expect(namesFolder(`env TMPDIR=${dir} sleep 1`, dir)).toBe(true)
    expect(namesFolder(`tail -f ${dir}`, dir)).toBe(true)
  })
  it('is not fooled by a longer name, a longer path or a bare pattern', () => {
    expect(namesFolder(`sh ${dir}d/x`, dir)).toBe(false)
    expect(namesFolder(`sh ${dir}-2/x`, dir)).toBe(false)
    expect(namesFolder(`sh ${dir}.x`, dir)).toBe(false)
    expect(namesFolder(`sh /private${dir}/x`, dir)).toBe(false)
    expect(namesFolder('sh /var/folders/x/T/talos-vitest-run-/x', dir)).toBe(false)
    expect(namesFolder('sh talos-vitest-run-', dir)).toBe(false)
  })
})
