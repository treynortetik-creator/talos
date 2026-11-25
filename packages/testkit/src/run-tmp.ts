// One temp folder per test run (#161), for the bridge's bun run (apps/bridge/test/run-tmp.ts) and the root vitest run
// (vitest.run-tmp.ts). It becomes TMPDIR, so every folder a test makes with tmpdir(), in process or in anything it spawns with
// that environment, goes under it, and end() removes it. Bun's spawn with no `env` passes the environment Bun started with,
// not a TMPDIR set at run time, so the bridge's `test` script and test-parallel.ts make the run folder before bun starts and
// this adopts it. A full run used to leave about 1 GB in some 4,000 folders behind, and on a tmpfs /tmp
// with a quota the next run failed with EDQUOT. A run that was killed leaves its folder; a later run removes any of the same
// prefix older than a day. Node only (not exported from the index, which also runs in the browser).
//
// A process a test started and left behind (a stub waiting for a file that never comes) outlives its test, and with its temp
// folder gone it runs for days. So before the folder is removed, end() looks for this user's processes whose command line names
// this run's folder. The run's own (orphaned, or below the runner) are printed and fail the run; one that belongs to someone else
// (an agent reading a log there) is printed and does not. Nothing is signalled: a stub ends by itself (scripts/wait-loop.ts).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { timeFactor } from './time-factor.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export function pruneOldRuns(outer: string, prefix: string, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(outer)
  } catch {
    return // an unreadable temp folder: nothing to prune
  }
  for (const f of names) {
    if (!f.startsWith(prefix)) continue
    const p = join(outer, f)
    try {
      if (now - statSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true })
    } catch {
      // already gone
    }
  }
}

export interface RunProcess {
  pid: number
  ppid: number
  command: string
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/

/** Every process, with its owner's uid, from `ps` (the full command line). Undefined when `ps` fails or hangs twice. */
function listProcesses(): (RunProcess & { uid: number })[] | undefined {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync('ps', ['-ww', '-A', '-o', 'pid=,ppid=,uid=,command='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10_000,
    })
    if (r.error || r.status !== 0) continue
    const out: (RunProcess & { uid: number })[] = []
    for (const line of r.stdout.split('\n')) {
      const m = PS_LINE.exec(line)
      if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), command: m[4] })
    }
    if (out.length > 0) return out
  }
  return undefined
}

/**
 * Whether `command` names the folder `dir` itself or something in it: the exact path, not followed by more name (a run `abc` is
 * not run `abcd`) and not the tail of a longer path.
 */
export function namesFolder(command: string, dir: string): boolean {
  for (let i = command.indexOf(dir); i !== -1; i = command.indexOf(dir, i + 1)) {
    const before = command[i - 1]
    const after = command[i + dir.length]
    if ((before === undefined || !/[\w.\-/]/.test(before)) && (after === undefined || !/[\w.-]/.test(after)))
      return true
  }
  return false
}

// What an agent or a person leaves running, not a test: an app's or an agent's own command line, or a program one reads a log with.
// An orphan like that is only named.
const PERSONS_PROGRAMS = ['vim', 'vi', 'nvim', 'nano', 'emacs', 'code', 'less', 'tail', 'ssh', 'claude']
const personsOwn = (command: string) =>
  command.includes('/shell-snapshots/') ||
  command.includes('.app/Contents/') ||
  PERSONS_PROGRAMS.includes(basename(command.split(/\s/)[0]))

/** The run folder as written and as the disk resolves it (they differ under /var on a Mac), the longer one first. */
function runFolderNames(dir: string): string[] {
  const names = [dir]
  try {
    const real = realpathSync(dir)
    if (real !== dir) names.push(real)
  } catch {
    // already gone: only the written path
  }
  return names.sort((a, b) => b.length - a.length)
}

export interface RunScan {
  /** Named the folder and are the run's own: orphaned, or below the runner, or below such a one. */
  owned: RunProcess[]
  /** Named the folder and are someone else's (an agent reading a log there, an editor, a shell): not the run's to answer for. */
  named: RunProcess[]
}

/**
 * This user's processes that name the run folder `dir` (as written and as the disk resolves it), sorted into the run's own and
 * the others. A process is the run's own when its parent is gone (init, `/init` or the user's systemd has it) and it is not an
 * agent's or a person's, when it is below this process, or when it is below one of those that names the folder. Pid 1, this
 * process and its ancestors are never listed. Undefined when the process list could not be read.
 */
export function scanRun(dir: string): RunScan | undefined {
  const names = runFolderNames(dir)
  const all = listProcesses()
  if (!all) return undefined
  const byPid = new Map(all.map((p) => [p.pid, p]))
  const ancestors = (p: RunProcess): RunProcess[] => {
    const out: RunProcess[] = []
    for (let q = byPid.get(p.ppid); q && q.pid > 1 && !out.includes(q); q = byPid.get(q.ppid)) out.push(q)
    return out
  }
  const self = byPid.get(process.pid)
  const mine = new Set([process.pid, process.ppid, ...(self ? ancestors(self).map((p) => p.pid) : [])])
  const uid = process.getuid?.()
  const matches = all.filter(
    (p) =>
      p.pid > 1 &&
      !mine.has(p.pid) &&
      (uid === undefined || p.uid === uid) &&
      names.some((n) => namesFolder(p.command, n)),
  )
  const matched = new Set(matches.map((p) => p.pid))
  const orphaned = (p: RunProcess) => {
    if (personsOwn(p.command)) return false
    if (p.ppid <= 1) return true
    const parent = byPid.get(p.ppid)?.command ?? ''
    return /^(\/init|init)(\s|$)/.test(parent) || /(^|\/)systemd\s+--user(\s|$)/.test(parent)
  }
  const belowUs = (p: RunProcess) => ancestors(p).some((a) => a.pid === process.pid)
  const base = (p: RunProcess) => orphaned(p) || belowUs(p)
  const scan: RunScan = { owned: [], named: [] }
  for (const p of matches) {
    const own = base(p) || ancestors(p).some((a) => matched.has(a.pid) && base(a))
    ;(own ? scan.owned : scan.named).push({ pid: p.pid, ppid: p.ppid, command: p.command })
  }
  return scan
}

const cut = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s)

/**
 * The run's own processes still running that name the run folder `dir`, once they have had graceMs to finish exiting (polled: a
 * clean run pays nothing; ci-local's watchdog takes seconds to stop its groups). Each is printed; so is each that is only named.
 * Nothing is signalled: with its folder gone and its caps, a stub ends by itself, and this says which test left it. When `ps`
 * cannot be read it says so and gives back none: that is not "nothing left".
 */
export function checkRunLeftovers(dir: string, graceMs = 10_000 * timeFactor()): RunProcess[] {
  const unreadable = () => {
    process.stderr.write(`could not read the process list: leftovers of this test run (${dir}) were not checked\n`)
    return []
  }
  let scan = scanRun(dir)
  for (const end = Date.now() + graceMs; scan && scan.owned.length > 0 && Date.now() < end; scan = scanRun(dir))
    sleepSync(50)
  if (!scan) return unreadable()
  // the long folder name is the same in every line: `<run>` leaves the part that names the test
  const names = runFolderNames(dir)
  const show = (p: RunProcess): RunProcess => ({
    ...p,
    command: names.reduce((c, n) => c.replaceAll(n, '<run>'), p.command),
  })
  for (const p of scan.named.map(show))
    process.stderr.write(`named by this test run, not its own: pid ${p.pid} ${cut(p.command)}\n`)
  const owned = scan.owned.map(show)
  for (const p of owned) process.stderr.write(`left running by this test run: pid ${p.pid} ${cut(p.command)}\n`)
  return owned
}

/** Removes the run folder after looking for what it left; throws (the run fails) when the run's own were left. */
function endRun(dir: string, graceMs: number | undefined, afterRemove: () => void): void {
  let left: RunProcess[] = []
  try {
    left = checkRunLeftovers(dir, graceMs)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a child still writing: a later run prunes it
    }
    afterRemove()
  }
  if (left.length > 0) {
    throw new Error(
      `${left.length} process(es) were left running by this test run (${dir}): ${left
        .map((p) => `pid ${p.pid} ${cut(p.command, 100)}`)
        .join('; ')}. A test must stop what it starts.`,
    )
  }
}

/**
 * Makes this run's folder under the current temp folder and points TMPDIR at it; end() removes it and restores TMPDIR. When
 * `adopt` is set and TMPDIR already is a run folder of this prefix (made before the runtime started, so even a child spawned
 * with no `env` has it), that folder is the run's: nothing is nested, and end() removes it. Only the bridge's bun run adopts: a
 * run started inside another run (a test that runs Vitest) inherits that run's TMPDIR and must not take its folder and end it.
 */
export function startRunTmp(
  prefix: string,
  { adopt = false, graceMs }: { adopt?: boolean; graceMs?: number } = {},
): { dir: string; end: () => void } {
  const current = tmpdir()
  if (adopt && basename(current).startsWith(prefix)) {
    pruneOldRuns(dirname(current), prefix)
    return { dir: current, end: () => endRun(current, graceMs, () => {}) }
  }
  const outer = current
  pruneOldRuns(outer, prefix)
  const dir = mkdtempSync(join(outer, prefix))
  const before = process.env.TMPDIR
  process.env.TMPDIR = dir
  return {
    dir,
    end: () =>
      endRun(dir, graceMs, () => {
        if (before === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = before
      }),
  }
}
