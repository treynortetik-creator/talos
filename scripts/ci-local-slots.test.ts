// scripts/ci-local.sh slots and locks. The lock functions are tested by sourcing the script (it stops after them); the
// queue + head re-resolve end to end with a local "origin", a fake `gh` that records the statuses it is asked to post,
// and a job name that does not exist (so the run is quick and posts pending + failure).
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
// The machine running the tests may be busy: the load guard is off unless a test turns it on.
const base = { CI_MAX_LOAD: '0', CI_POLL: '0.05', CI_LOCK_TIMEOUT: '20', TALOS_CI_NESTED: '0' }
// These tests start real shells, and the check job runs them beside two other CI runs. What they prove is the order of
// events, so no test depends on how fast the machine is: a slow run takes longer, a stuck one still fails at `until`.
const WAIT_MS = 30_000
vi.setConfig({ testTimeout: 4 * WAIT_MS })

type Bg = { child: ChildProcess; out: () => string; done: Promise<number> }
const live: Bg[] = []
afterEach(() => {
  for (const b of live.splice(0)) b.child.kill('SIGKILL')
})

function src(code: string) {
  return `. "${script}"\n${code}`
}
function sh(code: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', src(code)], { env: { ...cleanEnv(), ...base, ...env }, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
function bg(args: string[], env: Record<string, string> = {}, cwd?: string): Bg {
  const child = spawn('bash', args, { env: { ...cleanEnv(), ...base, ...env }, cwd })
  let out = ''
  child.stdout?.on('data', (d) => {
    out += d
  })
  child.stderr?.on('data', (d) => {
    out += d
  })
  const done = new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)))
  const b = { child, out: () => out, done }
  live.push(b)
  return b
}
const bgSh = (code: string, env: Record<string, string> = {}) => bg(['-c', src(code)], env)
async function until(what: string, ok: () => boolean, ms = WAIT_MS) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const scratchDirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'cil-'))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const what = (lock: string) => readFileSync(join(lock, 'what'), 'utf8').trim()

describe('ci-local.sh slots', () => {
  it('fills CI_SLOTS slots, then waits; a slot whose run died is taken over', async () => {
    const L = join(scratch(), 'locks')
    const holders = [1, 2, 3].map((i) => bgSh(`ci_acquire_slot "${L}" h${i} && echo "got slot $CI_SLOT"; sleep 60`))
    for (const h of holders) await until('a holder', () => h.out().includes('got slot'))
    expect(holders.map((h) => h.out().match(/got slot (\d)/)?.[1]).sort()).toEqual(['1', '2', '3'])

    const full = sh(`ci_acquire_slot "${L}" late`, { CI_LOCK_TIMEOUT: '1' })
    expect(full.code).not.toBe(0)
    expect(full.out).toMatch(/waiting for a free slot \(slot-1: h\d, slot-2: h\d, slot-3: h\d\)/)
    expect(full.out).toContain('lock timeout')

    const two = holders.find((h) => h.out().includes('got slot 2'))
    two?.child.kill('SIGKILL') // no cleanup runs: slot-2 is left behind with a dead owner
    await two?.done
    const next = sh(`ci_acquire_slot "${L}" next && echo "got slot $CI_SLOT"`)
    expect(next.out).toContain('took over slot-2 from a run that is gone')
    expect(next.out).toContain('got slot 2')
  })

  it("stale takeover: of many waiters racing for a dead owner's slot, exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const T = scratch()
      const L = join(T, 'slot-1')
      expect(sh(`ci_lock_try "${L}" dead`).code).toBe(0) // that shell exits: the owner is dead
      // A winner stays alive until every other racer has given up. The rule is one LIVE holder: once a winner exits, its lock
      // may rightly be taken over again, and a racer started late under load used to do that and fail this test.
      const racers = Array.from({ length: 10 }, (_, i) =>
        bgSh(
          `end=$(( $(date +%s) + 1 ))
           while [ "$(date +%s)" -le "$end" ]; do
             if ci_lock_try "${L}" r${i}; then echo WON; until [ -f "${T}/stop" ]; do sleep 0.02; done; exit 0; fi
           done`,
        ),
      )
      const winners = () => racers.filter((r) => r.out().includes('WON'))
      const gaveUp = () => racers.filter((r) => r.child.exitCode !== null).length
      await until('every other racer to give up', () => gaveUp() + winners().length === racers.length)
      const won = winners()
      writeFileSync(join(T, 'stop'), '')
      await Promise.all(racers.map((r) => r.done))
      expect(won).toHaveLength(1)
      expect(what(L)).toBe(`r${racers.indexOf(won[0] as Bg)}`)
    }
  }, 60_000)

  // These two hold a process at the worst moment, for as long as the test likes, with every time limit already passed. Before
  // this rule a stalled process woke up and wrote itself in over the waiter that had moved on, and both believed they held the
  // lock: 40 of 44 forced rounds, and 3 of 52 rounds of plain load (docs/CI-LOCAL.md, "How the locks work").
  const stallAt = (fn: string, T: string) =>
    `eval "real_${fn}() $(declare -f ${fn} | sed 1d)"
     ${fn}() { touch "${T}/stalled"; until [ -f "${T}/go" ]; do sleep 0.02; done; real_${fn} "$@"; }`
  const noGrace = { CI_LOCK_GRACE: '0' }

  it('a claimer stalled before it writes keeps its claim: nobody takes the lock from under it', async () => {
    const T = scratch()
    const L = join(T, 'slot-1')
    sh(`ci_lock_try "${L}" dead`)
    const stalled = bgSh(`${stallAt('ci_write_owner', T)}\nci_lock_try "${L}" staller && echo HELD; sleep 60`, noGrace)
    await until('the claimer to stall', () => existsSync(join(T, 'stalled')))
    expect(sh(`ci_lock_try "${L}" waiter && echo STOLE || echo WAITED`, noGrace).out).toContain('WAITED')
    writeFileSync(join(T, 'go'), '')
    await until('the claimer to finish', () => stalled.out().includes('HELD'))
    expect(what(L)).toBe('staller')
    expect(sh(`ci_lock_try "${L}" late && echo STOLE || echo WAITED`, noGrace).out).toContain('WAITED')
  })

  it('a creator stalled before it writes loses to the waiter that moved on, and leaves its lock alone', async () => {
    const T = scratch()
    const L = join(T, 'slot-1')
    const stalled = bgSh(
      `${stallAt('ci_new_owner', T)}\nif ci_lock_try "${L}" creator; then echo HELD; else echo LOST; fi; sleep 60`,
      noGrace,
    )
    await until('the creator to stall', () => existsSync(join(T, 'stalled')))
    const waiter = bgSh(`ci_lock_try "${L}" waiter && echo HELD; sleep 60`, noGrace)
    await until('the waiter to take over', () => waiter.out().includes('HELD'))
    writeFileSync(join(T, 'go'), '')
    await until('the creator to wake', () => stalled.out().includes('LOST') || stalled.out().includes('HELD'))
    expect(stalled.out()).toContain('LOST')
    expect(what(L)).toBe('waiter')
    expect(existsSync(L)).toBe(true)
  })

  it('a claimer that died leaves the takeover to the next waiter', () => {
    const L = join(scratch(), 'slot-1')
    sh(`ci_lock_try "${L}" dead`)
    const key = sh(`ci_owner_key "$(ci_owner "${L}")"`).out.trim()
    expect(sh(`ln -s "$(ci_me)" "${L}/takeover-${key}.0"`).code).toBe(0) // that shell exits holding the claim
    expect(sh(`ci_lock_try "${L}" next && echo GOT`).out).toContain('GOT')
    expect(what(L)).toBe('next')
  })

  it('a failed ps does not make a run stop recognising its own lock', () => {
    const L = join(scratch(), 'slot-1')
    const r = sh(`ci_lock_try "${L}" mine
      ps() { return 1; }
      ci_lock_release "${L}"
      [ -e "${L}" ] && echo KEPT || echo RELEASED`)
    expect(r.out).toContain('RELEASED')
  })

  it('a waiter that saw a dead owner cannot take the lock once someone else has it', async () => {
    const T = scratch()
    const L = join(T, 'slot-1')
    sh(`ci_lock_try "${L}" dead`)
    const seen = sh(`ci_owner "${L}"`).out
    // A: another waiter took it over and is still running. B: it was taken over, released, and taken fresh by a live run.
    const a = bgSh(`ci_lock_try "${L}" taker && echo HELD; sleep 60`)
    await until('the taker', () => a.out().includes('HELD'))
    const stalled = `seen="$(cat "${T}/seen")"; ci_lock_takeover "${L}" "$seen" "$(ci_owner_key "$seen")" stalled && echo STOLE || echo REFUSED`
    writeFileSync(join(T, 'seen'), seen)
    expect(sh(stalled).out).toContain('REFUSED')
    expect(what(L)).toBe('taker')

    a.child.kill('SIGTERM')
    await a.done
    sh(`ci_lock_try "${L}" again && ci_lock_release "${L}"`) // takes over the dead taker, then releases properly
    expect(existsSync(L)).toBe(false)
    const fresh = bgSh(`ci_lock_try "${L}" fresh && echo HELD; sleep 60`)
    await until('the fresh run', () => fresh.out().includes('HELD'))
    expect(sh(stalled).out).toContain('REFUSED') // the takeover mkdir succeeds in the new lock, the owner re-check stops it
    expect(what(L)).toBe('fresh')
  })

  it('a reused pid is not a live owner (the start time must match)', () => {
    const L = join(scratch(), 'slot-1')
    mkdirSync(L)
    writeFileSync(join(L, 'owner'), `${process.pid}\nMon Jan  1 00:00:00 2001\nold`)
    const r = sh(`ci_lock_try "${L}" new && echo GOT`)
    expect(r.out).toContain('GOT')
    expect(what(L)).toBe('new')
  })

  it('a lock with no owner file is left alone for the grace period, then taken over', () => {
    const L = join(scratch(), 'slot-1')
    mkdirSync(L)
    expect(sh(`ci_lock_try "${L}" x && echo GOT || echo WAIT`).out).toContain('WAIT')
    execFileSync('touch', ['-t', '202001010000', L])
    expect(sh(`ci_lock_try "${L}" x && echo GOT || echo WAIT`).out).toContain('GOT')
  })

  it('release leaves a lock this process does not own', async () => {
    const L = join(scratch(), 'slot-1')
    const a = bgSh(`ci_lock_try "${L}" a && echo HELD; sleep 60`)
    await until('the holder', () => a.out().includes('HELD'))
    sh(`ci_lock_release "${L}"`)
    expect(what(L)).toBe('a')
    expect(sh(`ci_lock_try "${L}" b && echo GOT || echo BUSY`).out).toContain('BUSY')
  })

  it('waits while the 5-min load average is above CI_MAX_LOAD, then starts', () => {
    const T = scratch()
    const fake = `ci_load5() { n=$(cat "${T}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${T}/n"; if [ "$n" -lt 4 ]; then echo 20.5; else echo 3.1; fi; }`
    const r = sh(`${fake}; ci_acquire_slot "${T}/locks" x && echo "got slot $CI_SLOT"`, { CI_MAX_LOAD: '14' })
    expect(r.out).toContain('waiting: 5-min load average 20.5 is above CI_MAX_LOAD=14')
    expect(r.out.match(/waiting:/g)).toHaveLength(1) // said once, not every poll
    expect(r.out).toContain('got slot 1')
    expect(Number(readFileSync(join(T, 'n'), 'utf8'))).toBeGreaterThan(4)
  })

  it('the load guard is off for CI_MAX_LOAD=0 and for a run nested in another run', () => {
    const T = scratch()
    const busy = 'ci_load5() { echo 99; }'
    expect(sh(`${busy}; ci_acquire_slot "${T}/a" x && echo GOT`, { CI_MAX_LOAD: '0' }).out).toContain('GOT')
    expect(
      sh(`${busy}; ci_acquire_slot "${T}/b" x && echo GOT`, { CI_MAX_LOAD: '14', TALOS_CI_NESTED: '1' }).out,
    ).toContain('GOT')
    const r = sh(`${busy}; ci_acquire_slot "${T}/c" x && echo GOT`, { CI_MAX_LOAD: '14', CI_LOCK_TIMEOUT: '0' })
    expect(r.out).not.toContain('GOT')
    expect(r.out).toContain('above CI_MAX_LOAD=14')
  })

  it('reads a real load average on this machine', () => {
    expect(sh('ci_load5').out.trim()).toMatch(/^\d+([.,]\d+)?$/)
  })

  it('gives every slot its own ports and temp dir; slot 1 keeps the old Playwright port', () => {
    const env = (n: number, extra: Record<string, string> = {}) =>
      sh(`CI_TMP_BASE=/t; ci_slot_env ${n}; echo "$SLOT_PW_PORT $SLOT_IMAGE_PORT_BASE $SLOT_TMP"`, extra).out.trim()
    expect(env(1)).toBe('4873 18080 /t/talos-ci-s1')
    expect(env(2)).toBe('4883 18180 /t/talos-ci-s2')
    expect(env(3)).toBe('4893 18280 /t/talos-ci-s3')
    expect(env(2, { TALOS_CI_PW_PORT: '5000' })).toBe('5010 18180 /t/talos-ci-s2')
  })

  it('a mutex lets one holder at a time run its step', async () => {
    const T = scratch()
    const f = join(T, 'log')
    const step = (i: number) =>
      bgSh(`ci_mutex "${T}/locks" desktop sh -c 'echo start${i} >> "${f}"; sleep 0.4; echo end${i} >> "${f}"'`)
    const a = step(1)
    const b = step(2)
    await Promise.all([a.done, b.done])
    const lines = readFileSync(f, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]?.replace('start', 'end')).toBe(lines[1])
    expect(lines[2]?.replace('start', 'end')).toBe(lines[3])
    expect(`${a.out()}${b.out()}`).toContain('waiting for the desktop mutex')
    expect(readdirSync(join(T, 'locks'))).toEqual([])
  })
})

describe('ci-local.sh queued runs', () => {
  function repo() {
    const T = scratch()
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        cwd,
        encoding: 'utf8',
      }).trim()
    const srcDir = join(T, 'src')
    mkdirSync(srcDir)
    git(srcDir, 'init', '-q', '-b', 'main')
    writeFileSync(join(srcDir, 'a.txt'), 'a\n')
    git(srcDir, 'add', '-A')
    git(srcDir, 'commit', '-qm', 'a')
    const A = git(srcDir, 'rev-parse', 'HEAD')
    const origin = join(T, 'origin.git')
    git(T, 'clone', '-q', '--bare', srcDir, origin)
    git(origin, 'update-ref', 'refs/pull/7/head', A)
    git(srcDir, 'remote', 'add', 'origin', origin)
    const clone = join(T, 'clone')
    git(T, 'clone', '-q', origin, clone)
    mkdirSync(join(clone, 'scripts'))
    writeFileSync(join(clone, 'scripts', 'ci-local.sh'), readFileSync(script))
    const bin = join(T, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\ncase "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG" ;; esac\n',
    )
    chmodSync(join(bin, 'gh'), 0o755)
    writeFileSync(join(bin, 'swift'), '#!/bin/sh\nexit 0\n') // only so job_desktop gets past "is swift installed"
    chmodSync(join(bin, 'swift'), 0o755)
    // job_desktop fails without a usable tmux (the machine's own is not the test's business): a stand-in at a path of ours
    writeFileSync(join(bin, 'tmux'), "#!/bin/sh\necho 'tmux 3.5'\n")
    chmodSync(join(bin, 'tmux'), 0o755)
    const home = join(T, 'home')
    mkdirSync(home)
    const env = {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: join(T, 'gh.log'),
      CI_SLOTS: '1',
      CI_TMUX_PATHS: join(bin, 'tmux'),
      TMPDIR: T,
    }
    const statuses = () => (existsSync(env.GH_LOG) ? readFileSync(env.GH_LOG, 'utf8').trim().split('\n') : [])
    const pushHead = (file: string) => {
      writeFileSync(join(srcDir, file), `${file}\n`)
      git(srcDir, 'add', '-A')
      git(srcDir, 'commit', '-qm', file)
      git(srcDir, 'push', '-q', origin, 'HEAD:refs/pull/7/head')
      return git(srcDir, 'rev-parse', 'HEAD')
    }
    const ciLocal = (...a: string[]) => bg([join(clone, 'scripts', 'ci-local.sh'), ...a], env, clone)
    const ciLocalWith = (extra: Record<string, string>, ...a: string[]) =>
      bg([join(clone, 'scripts', 'ci-local.sh'), ...a], { ...env, ...extra }, clone)
    return { A, env, home, clone, statuses, pushHead, ciLocal, ciLocalWith, git }
  }

  it('re-resolves the PR head after waiting for a slot, and posts statuses only for the commit it tested', async () => {
    const r = repo()
    const locks = join(r.home, '.cache', 'talos-ci', 'locks')
    const holder = bgSh(`ci_acquire_slot "${locks}" holder && echo HELD; sleep 60`, r.env)
    await until('the holder', () => holder.out().includes('HELD'))

    const run = r.ciLocal('--pr', '7', '--jobs', 'nope')
    await until('the run to queue', () => run.out().includes('waiting for a free slot (slot-1: holder)'))
    const B = r.pushHead('b.txt') // the PR gets a new commit while the run is queued
    holder.child.kill('SIGKILL') // and the run holding the only slot dies without cleaning up
    const code = await run.done

    expect(code).toBe(1) // the job does not exist, so it fails; that is all this run needs to do
    expect(run.out()).toContain('took over slot-1')
    expect(run.out()).toContain(
      `PR 7 head moved while queued (${r.A.slice(0, 7)} -> ${B.slice(0, 7)}); testing ${B.slice(0, 7)}`,
    )
    expect(run.out()).toContain(`ci-local: ${B.slice(0, 7)} (PR 7) slot 1/1, jobs: nope`)
    const posted = r.statuses()
    expect(posted.length).toBe(2)
    expect(posted.every((l) => l.includes(`repos/owner/repo/statuses/${B} `))).toBe(true)
    expect(posted.some((l) => l.includes(r.A))).toBe(false)
    expect(posted[0]).toContain('state=pending')
    expect(posted[1]).toContain('state=failure')
    expect(readdirSync(locks)).toEqual([]) // its slot is released
    expect(r.git(r.clone, 'for-each-ref', 'refs/talos-ci')).toBe('') // its private fetch ref is gone
    expect(r.git(r.clone, 'worktree', 'list').split('\n')).toHaveLength(1) // and its scratch worktree
  }, 30_000)

  it('tests the head it resolved when the PR did not move', async () => {
    const r = repo()
    const run = r.ciLocal('--pr', '7', '--jobs', 'nope')
    await run.done
    expect(run.out()).not.toContain('head moved')
    expect(run.out()).not.toContain('waiting')
    const posted = r.statuses()
    expect(posted.length).toBe(2)
    expect(posted.every((l) => l.includes(`statuses/${r.A} `))).toBe(true)
  }, 30_000)

  it('runs in its own slot temp dir with its own Playwright port, marked as a slot run, and cleans the temp dir up', async () => {
    const r = repo()
    // a job that only the test defines: write it into the clone's copy, then run it
    const copy = join(r.clone, 'scripts', 'ci-local.sh')
    const body = readFileSync(copy, 'utf8').replace(
      '\ncd "$WT"\n',
      '\njob_probe() { echo "tmp=$TMPDIR pw=$PW_PORT slot=$CI_SLOT marker=$TALOS_CI_SLOT_RUN" > "$HOME/probe"; }\ncd "$WT"\n',
    )
    writeFileSync(copy, body)
    const run = r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status')
    expect(await run.done).toBe(0)
    const probe = readFileSync(join(r.home, 'probe'), 'utf8').trim()
    expect(probe).toMatch(/tmp=.*\/talos-ci-s1 pw=4873 slot=1 marker=1$/)
    const tmp = probe.match(/tmp=(\S+)/)?.[1] ?? ''
    expect(existsSync(tmp)).toBe(false)
  }, 30_000)

  // 2026-11-05: a bridge test left a real kit release (read-only by design) in the slot's temp dir, and the next run's cleanup
  // failed on it with exit 1. Every CI run on main failed from then on.
  it('cleans up a slot temp dir that a job left read-only', async () => {
    const r = repo()
    const copy = join(r.clone, 'scripts', 'ci-local.sh')
    const body = readFileSync(copy, 'utf8').replace(
      '\ncd "$WT"\n',
      '\njob_probe() { mkdir -p "$TMPDIR/rel/kit" && : > "$TMPDIR/rel/kit/f" && chmod -R a-w "$TMPDIR/rel"; echo "tmp=$TMPDIR" > "$HOME/probe"; }\ncd "$WT"\n',
    )
    writeFileSync(copy, body)
    expect(await r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status').done).toBe(0)
    const tmp = readFileSync(join(r.home, 'probe'), 'utf8').match(/tmp=(\S+)/)?.[1] ?? ''
    expect(tmp).toContain('talos-ci-s1')
    expect(existsSync(tmp)).toBe(false)
    expect(await r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status').done).toBe(0)
  }, 30_000)

  it('starts cleanly when a read-only folder is already sitting in its slot temp dir', async () => {
    const r = repo()
    const copy = join(r.clone, 'scripts', 'ci-local.sh')
    const body = readFileSync(copy, 'utf8').replace(
      '\ncd "$WT"\n',
      '\njob_probe() { echo "tmp=$TMPDIR" > "$HOME/probe"; }\ncd "$WT"\n',
    )
    writeFileSync(copy, body)
    expect(await r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status').done).toBe(0)
    const tmp = readFileSync(join(r.home, 'probe'), 'utf8').match(/tmp=(\S+)/)?.[1] ?? ''
    mkdirSync(join(tmp, 'stale', 'kit'), { recursive: true })
    writeFileSync(join(tmp, 'stale', 'kit', 'f'), '')
    spawnSync('chmod', ['-R', 'a-w', join(tmp, 'stale')])
    expect(await r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status').done).toBe(0)
    expect(existsSync(join(tmp, 'stale'))).toBe(false)
  }, 30_000)

  // 2026-10-30: every `pnpm test` in a builder's checkout ran this script with a fake HOME (other locks, so slot 1 was free)
  // and the owner's TMPDIR, and its `rm -rf` emptied real slot 1's temp dir under the real run. That one bug failed
  // chromium-media in bulk (browser launch ENOENT), two e2e schedules tests and the desktop job (swiftc couldNotFindTmpDir).
  it('a run under another HOME leaves the temp dir of a run holding that slot alone, whatever TMPDIR says', async () => {
    const r = repo()
    const shared = scratch()
    const inUse = join(shared, 'talos-ci-s1', 'in-use')
    mkdirSync(dirname(inUse))
    writeFileSync(inUse, 'a browser profile')
    const run = r.ciLocalWith({ TMPDIR: shared }, '--ref', 'HEAD', '--jobs', 'nope', '--no-status')
    await run.done
    expect(run.out()).toContain('slot 1/1')
    expect(existsSync(inUse)).toBe(true)
  })

  it('runs in a temp dir under its own HOME, the same root as the lock that makes it the owner', async () => {
    const r = repo()
    const copy = join(r.clone, 'scripts', 'ci-local.sh')
    writeFileSync(
      copy,
      readFileSync(copy, 'utf8').replace(
        '\ncd "$WT"\n',
        '\njob_probe() { echo "$TMPDIR" > "$HOME/probe"; }\ncd "$WT"\n',
      ),
    )
    expect(await r.ciLocal('--ref', 'HEAD', '--jobs', 'probe', '--no-status').done).toBe(0)
    expect(readFileSync(join(r.home, 'probe'), 'utf8').trim()).toBe(
      join(r.home, '.cache', 'talos-ci', 'tmp', 'talos-ci-s1'),
    )
  })

  it('the whole desktop script runs under the desktop mutex; SwiftPM scratch and cache are the shared ones only it uses', async () => {
    const r = repo()
    const scriptDir = join(r.clone, 'apps', 'desktop', 'scripts')
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(
      join(scriptDir, 'ci.sh'),
      `#!/bin/sh
{
  echo "mutex=$(cat "$HOME/.cache/talos-ci/locks/mutex-desktop/what")"
  echo "scratch=$TALOS_SWIFT_SCRATCH"
  echo "cache=$TALOS_SWIFTPM_CACHE"
  [ -d "$TMPDIR" ] && echo tmp=there
} > "$HOME/desktop-probe"
`,
    )
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'desktop stub')
    const run = r.ciLocalWith({ TALOS_CI_FORCE_DESKTOP: '1' }, '--ref', 'HEAD', '--jobs', 'desktop', '--no-status')
    expect(await run.done).toBe(0)
    const cache = join(r.home, '.cache', 'talos-ci')
    expect(readFileSync(join(r.home, 'desktop-probe'), 'utf8').trim().split('\n')).toEqual([
      'mutex=slot 1',
      `scratch=${join(cache, 'desktop-build')}`,
      `cache=${join(cache, 'swiftpm')}`,
      'tmp=there',
    ])
    const text = readFileSync(script, 'utf8')
    // no other step reaches them: exactly one command names the scratch, and it is the one under the mutex
    expect(text.match(/TALOS_SWIFT_SCRATCH=/g)).toHaveLength(1)
    expect(text).toMatch(
      /TALOS_SWIFT_SCRATCH="\$CACHE\/desktop-build" \\\n\s+run "\$log" ci_mutex "\$LOCKS" desktop bash /,
    )
  })

  it('rejects a bad CI_SLOTS and keeps the CLI flags', () => {
    const r = repo()
    const bad = spawnSync('bash', [join(r.clone, 'scripts', 'ci-local.sh'), '--ref', 'HEAD'], {
      env: { ...cleanEnv(), ...r.env, CI_SLOTS: 'many' },
      encoding: 'utf8',
    })
    expect(bad.status).toBe(64)
    const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
    for (const flag of ['--pr', '--ref', '--jobs', '--latest', '--no-status', '--keep', 'CI_SLOTS', 'CI_MAX_LOAD'])
      expect(help.stdout).toContain(flag)
    expect(spawnSync('bash', [script, '--bogus'], { encoding: 'utf8' }).status).toBe(64)
  })
})
