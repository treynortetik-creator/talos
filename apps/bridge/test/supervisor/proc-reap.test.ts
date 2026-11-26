// What a cut session left running (src/supervisor/proc-reap.ts): found by the launch nonce in its environment, ended once.

import { describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { t } from '@talos-app/testkit'
import {
  bootMsNow,
  findLaunchProcs,
  REAP_GRACE_MS,
  REAP_START_SLACK_MS,
  type ReapDeps,
  reapLaunch,
} from '../../src/supervisor/proc-reap.ts'

const NONCE = 'ab'.repeat(16)
const OTHER = 'cd'.repeat(16)

type Fake = { pid: number; pgid: number; env: string[] | null; start: string; started?: number }

/** A fake process table: kills are recorded; a signalled process is gone unless its pid is in `immune`. */
function world(procs: Fake[], o: { immune?: number[]; reuse?: number[]; self?: { pid: number; pgid: number } } = {}) {
  const table = new Map(procs.map((p) => [p.pid, { ...p }]))
  const kills: Array<[number, string]> = []
  const startReads = new Map<number, number>()
  const d: ReapDeps = {
    pids: () => [...table.keys()],
    environ: (pid) => {
      const p = table.get(pid)
      return p?.env ? p.env.join('\0') : null
    },
    start: (pid) => {
      const p = table.get(pid)
      if (!p) return null
      const n = (startReads.get(pid) ?? 0) + 1
      startReads.set(pid, n)
      // a pid that is reused between the look and the signal: its start time is another one on the second read
      return o.reuse?.includes(pid) && n > 1 ? `${p.start}-new` : p.start
    },
    pgid: (pid) => table.get(pid)?.pgid ?? null,
    startedBootMs: (pid) => table.get(pid)?.started ?? null,
    alive: (pid) => table.has(pid),
    kill: (target, sig) => {
      kills.push([target, sig])
      const gone = (p: Fake) => sig === 'SIGKILL' || !o.immune?.includes(p.pid)
      for (const p of [...table.values()])
        if ((target < 0 && p.pgid === -target) || target === p.pid) if (gone(p)) table.delete(p.pid)
      return true
    },
    self: o.self ?? { pid: 100, pgid: 100 },
    graceMs: REAP_GRACE_MS,
    sleep: async () => {},
  }
  return { d, kills, table }
}
const env = (nonce: string) => ['PATH=/usr/bin', `TALOS_APP_WORKER_NONCE=${nonce}`, 'HOME=/home/alex']

describe('finding what a launch left (by its nonce)', () => {
  it('finds exactly the processes whose environment holds the whole entry', () => {
    const w = world([
      { pid: 200, pgid: 200, env: env(NONCE), start: 'a' },
      { pid: 201, pgid: 201, env: env(OTHER), start: 'b' },
      { pid: 202, pgid: 202, env: [`TALOS_APP_WORKER_NONCE=${NONCE}x`], start: 'c' }, // longer value: not it
      { pid: 203, pgid: 203, env: [`X_TALOS_APP_WORKER_NONCE=${NONCE}`], start: 'd' }, // another name: not it
      { pid: 204, pgid: 204, env: null, start: 'e' }, // unreadable: not provably ours
      { pid: 205, pgid: 205, env: ['PATH=/usr/bin'], start: 'f' },
    ])
    expect(findLaunchProcs(NONCE, w.d).map((f) => f.pid)).toEqual([200])
  })
  it('never ourselves or our own group, and never pid 1', () => {
    const w = world(
      [
        { pid: 100, pgid: 100, env: env(NONCE), start: 'a' },
        { pid: 150, pgid: 100, env: env(NONCE), start: 'b' }, // in the supervisor’s own group
        { pid: 1, pgid: 1, env: env(NONCE), start: 'c' },
        { pid: 300, pgid: 300, env: env(NONCE), start: 'd' },
      ],
      { self: { pid: 100, pgid: 100 } },
    )
    expect(findLaunchProcs(NONCE, w.d).map((f) => f.pid)).toEqual([300])
  })
  it('a nonce that is not a real one finds nothing, and reads nothing', () => {
    const w = world([{ pid: 200, pgid: 200, env: ['TALOS_APP_WORKER_NONCE='], start: 'a' }])
    for (const n of ['', 'abc', 'zz'.repeat(16), `${NONCE}\0x`]) expect(findLaunchProcs(n, w.d)).toEqual([])
  })
})

describe('ending them: one pass, TERM then KILL', () => {
  it('a group that is wholly the launch’s gets one TERM to the group', async () => {
    const w = world([
      { pid: 200, pgid: 200, env: env(NONCE), start: 'a' }, // a tool and its own child, one group
      { pid: 201, pgid: 200, env: env(NONCE), start: 'b' },
    ])
    const r = await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([[-200, 'SIGTERM']])
    expect(r).toMatchObject({ found: 2 })
    expect(w.table.size).toBe(0)
  })
  it('a group with a process that is not the launch’s is not signalled as a group: only the matched pids are', async () => {
    const w = world([
      { pid: 200, pgid: 200, env: env(NONCE), start: 'a' },
      { pid: 201, pgid: 200, env: env(OTHER), start: 'b' }, // someone else in the same group, and we can read that it is
    ])
    await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([[200, 'SIGTERM']])
    expect(w.table.has(201)).toBe(true)
  })
  it('a member whose environment cannot be read (ping hides it) in a group the launch leads goes with the group', async () => {
    const w = world([
      { pid: 200, pgid: 200, env: env(NONCE), start: 'a' }, // sh -c "ping ... || sleep"
      { pid: 201, pgid: 200, env: null, start: 'b' }, // ping: file capabilities, environ unreadable
    ])
    const r = await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([[-200, 'SIGTERM']])
    expect(r.found).toBe(1)
    expect(w.table.size).toBe(0)
  })
  it('an unreadable process in a group the launch does not lead is not touched', async () => {
    const w = world([
      { pid: 200, pgid: 150, env: env(NONCE), start: 'a' }, // it joined a group that someone else leads
      { pid: 150, pgid: 150, env: null, start: 'b' },
    ])
    await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([[200, 'SIGTERM']])
    expect(w.table.has(150)).toBe(true)
  })
  it('what ignores TERM gets one KILL after the grace, the rest are left alone', async () => {
    const w = world(
      [
        { pid: 200, pgid: 200, env: env(NONCE), start: 'a' },
        { pid: 300, pgid: 300, env: env(NONCE), start: 'b' },
      ],
      { immune: [300] },
    )
    const slept: number[] = []
    w.d.sleep = async (ms) => {
      slept.push(ms)
    }
    // the grace runs out with 300 still there
    let clock = 0
    w.d.now = () => (clock += 500)
    const r = await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([
      [-200, 'SIGTERM'],
      [-300, 'SIGTERM'],
      [-300, 'SIGKILL'],
    ])
    expect(r.killed).toEqual([300])
  })
  it('the grace is 2 seconds', () => expect(REAP_GRACE_MS).toBe(2000))
  it('a pid that was reused between the look and the signal is not signalled', async () => {
    const w = world([{ pid: 200, pgid: 200, env: env(NONCE), start: 'a' }], { reuse: [200] })
    await reapLaunch(NONCE, w.d)
    expect(w.kills).toEqual([])
    expect(w.table.has(200)).toBe(true)
  })
  it('nothing found: nothing signalled', async () => {
    const w = world([{ pid: 201, pgid: 201, env: env(OTHER), start: 'b' }])
    expect(await reapLaunch(NONCE, w.d)).toMatchObject({ found: 0 })
    expect(w.kills).toEqual([])
  })
})

describe('the real thing (Linux)', () => {
  // skip: Linux only, it reads /proc and needs real processes
  const linux = it.skipIf(process.platform !== 'linux')
  linux(
    'a detached child holding the nonce is ended; one without it is left running',
    async () => {
      const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
      const mine = spawn('sleep', ['300'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TALOS_APP_WORKER_NONCE: nonce },
      })
      const other = spawn('sleep', ['300'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TALOS_APP_WORKER_NONCE: 'ef'.repeat(16) },
      })
      const done = new Promise<void>((r) => mine.once('exit', () => r()))
      try {
        await new Promise((r) => setTimeout(r, t(100)))
        const r = await reapLaunch(nonce)
        expect(r.found).toBe(1)
        await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('still running')), t(5000)))])
        expect(other.exitCode).toBeNull()
        expect(() => process.kill(other.pid as number, 0)).not.toThrow()
      } finally {
        for (const c of [mine, other])
          if (c.pid && c.exitCode === null && c.signalCode === null) process.kill(c.pid, 'SIGKILL')
      }
    },
    15000,
  )
})

describe('only what started at or after the cut turn’s start (review fix 3)', () => {
  const T = 1_000_000 // the turn began here (ms)
  const SLACK = 1000
  const dev = (pid: number, started: number | undefined): Fake => ({
    pid,
    pgid: pid,
    env: env(NONCE),
    start: `s${pid}`,
    ...(started === undefined ? {} : { started }),
  })
  it('a server an earlier turn started (nohup, setsid) is left running; what this turn started is ended', async () => {
    const w = world([dev(200, T - 600_000), dev(300, T + 5_000)])
    const r = await reapLaunch(NONCE, w.d, T)
    expect(w.kills).toEqual([[-300, 'SIGTERM']])
    expect(w.table.has(200)).toBe(true)
    expect(r.found).toBe(1)
  })
  it('the edge: the slack for the clock’s resolution counts it in, a hair past it does not', async () => {
    const w = world([dev(200, T - SLACK), dev(201, T - SLACK - 1)])
    await reapLaunch(NONCE, w.d, T)
    expect(w.kills).toEqual([[-200, 'SIGTERM']])
  })
  it('a start time that cannot be read is not provably this turn’s: left alone', async () => {
    const w = world([dev(200, undefined)])
    await reapLaunch(NONCE, w.d, T)
    expect(w.kills).toEqual([])
  })
  it('without a bound (the caller has none) every process of the launch is found, as before', async () => {
    const w = world([dev(200, T - 600_000), dev(300, T + 5_000)])
    expect((await reapLaunch(NONCE, w.d)).found).toBe(2)
  })
  it('a group led by an earlier process is not signalled as a group: only its newer members are', async () => {
    const w = world([
      { pid: 200, pgid: 200, env: env(NONCE), start: 'a', started: T - 600_000 }, // the old leader (a dev server)
      { pid: 201, pgid: 200, env: env(NONCE), start: 'b', started: T + 1_000 }, // something it was asked to run this turn
    ])
    await reapLaunch(NONCE, w.d, T)
    expect(w.kills).toEqual([[201, 'SIGTERM']])
    expect(w.table.has(200)).toBe(true)
  })
})

describe('the real thing, bounded and with an unreadable member (Linux)', () => {
  // skip: Linux only, it reads /proc and needs real processes
  const linux = it.skipIf(process.platform !== 'linux')
  const newNonce = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  linux(
    'a tool from before the bound is left running, one from after it is ended (real /proc start times)',
    async () => {
      const nonce = newNonce()
      const mk = () =>
        spawn('sleep', ['300'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TALOS_APP_WORKER_NONCE: nonce },
        })
      const before = mk()
      const kids = [before]
      try {
        await new Promise((r) => setTimeout(r, REAP_START_SLACK_MS + t(1500)))
        const bound = bootMsNow() as number
        await new Promise((r) => setTimeout(r, t(300)))
        const after = mk()
        kids.push(after)
        const done = new Promise<void>((r) => after.once('exit', () => r()))
        await new Promise((r) => setTimeout(r, t(200)))
        const r = await reapLaunch(nonce, undefined, bound)
        expect(r.found).toBe(1)
        await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('still running')), t(5000)))])
        expect(alive(before.pid as number)).toBe(true)
      } finally {
        for (const c of kids) if (c.pid && c.exitCode === null && c.signalCode === null) process.kill(c.pid, 'SIGKILL')
      }
    },
    15000,
  )
  linux(
    'a shell and the ping under it (ping hides its environment): the group goes, the unreadable member with it',
    async () => {
      const nonce = newNonce()
      const sh = spawn('sh', ['-c', 'ping -c 300 -i 1 127.0.0.1 >/dev/null 2>&1 || sleep 300'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TALOS_APP_WORKER_NONCE: nonce },
      })
      let ping = 0
      try {
        await new Promise((r) => setTimeout(r, t(800)))
        const kid = spawnSync('pgrep', ['-P', String(sh.pid)], { encoding: 'utf8' })
          .stdout.trim()
          .split('\n')[0]
        ping = Number(kid)
        expect(ping).toBeGreaterThan(1)
        let unreadable = false
        try {
          readFileSync(`/proc/${ping}/environ`)
        } catch {
          unreadable = true // the case this test is for: ping has file capabilities
        }
        console.log(
          `ping's environ is ${unreadable ? 'unreadable (the group rule is what ends it)' : 'readable here (found by its own nonce)'}`,
        )
        const done = new Promise<void>((r) => sh.once('exit', () => r()))
        await reapLaunch(nonce)
        await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('still running')), t(5000)))])
        await new Promise((r) => setTimeout(r, t(300)))
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(ping)], { encoding: 'utf8' }).stdout.trim()
        expect(state === '' || state.startsWith('Z')).toBe(true) // ping is gone with its shell
      } finally {
        for (const p of [sh.pid, ping]) if (p && alive(p)) process.kill(p, 'SIGKILL')
      }
    },
    15000,
  )
})
