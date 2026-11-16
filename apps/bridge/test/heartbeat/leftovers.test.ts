// endLeftovers: the group of a source that has exited is signalled only while it has members, all of the source's session, and
// is not ours: TERM, a look again after the grace, KILL only if members are still there. Anything else signals nothing.
import { describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { t } from '@talos-app/testkit'
import {
  endLeftovers,
  type LeftoverDeps,
  type Member,
  recordSpawn,
  type Spawned,
} from '../../src/heartbeat/leftovers.ts'
import { runSource } from '../../src/heartbeat/spawn.ts'

const REC: Spawned = { pid: 4242, pgid: 4242, sid: 4242 }

function fake(rounds: Array<Member[] | 'unknown'>, sid: (pid: number) => number | undefined = () => REC.sid) {
  const sent: string[] = []
  const lines: string[] = []
  let i = 0
  const deps: Partial<LeftoverDeps> = {
    members: async () => rounds[Math.min(i++, rounds.length - 1)] as Member[] | 'unknown',
    sessionOf: sid,
    signal: (g, sig) => {
      sent.push(`${sig} -${g}`)
    },
    sleep: async () => {},
    graceMs: 0,
    log: (l) => lines.push(l),
  }
  return { deps, sent, lines }
}
const m = (pid: number): Member => ({ pid, pgid: REC.pgid })

describe('endLeftovers', () => {
  test('an empty group is never signalled, and says so', async () => {
    const f = fake([[]])
    expect(await endLeftovers(REC, f.deps)).toBe('none')
    expect(f.sent).toEqual([])
    expect(f.lines).toEqual(['no leftovers'])
  })

  test('a group ps could not list is not signalled, and says why', async () => {
    const f = fake(['unknown'])
    expect(await endLeftovers(REC, f.deps)).toBe('none')
    expect(f.sent).toEqual([])
    expect(f.lines).toEqual(['leftovers not checked: ps did not answer'])
  })

  test('a signal that fails (the group went in between) is reported, not thrown', async () => {
    const f = fake([[m(5001)]])
    const r = await endLeftovers(REC, {
      ...f.deps,
      signal: () => {
        throw new Error('ESRCH')
      },
    })
    expect(r).toBe('refused')
  })

  test('members of another session are not signalled', async () => {
    const f = fake([[m(5001), m(5002)]], (pid) => (pid === 5002 ? 777 : REC.sid))
    expect(await endLeftovers(REC, f.deps)).toBe('none')
    expect(f.sent).toEqual([])
  })

  test('a member whose session cannot be read is not signalled', async () => {
    const f = fake([[m(5001)]], () => undefined)
    expect(await endLeftovers(REC, f.deps)).toBe('none')
    expect(f.sent).toEqual([])
  })

  test('group 0, 1, our pid or our own group is never signalled', async () => {
    const own = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
    expect(own).toBeGreaterThan(1)
    for (const pgid of [0, 1, process.pid, own]) {
      const f = fake([[{ pid: 5001, pgid }]])
      expect(await endLeftovers({ pid: pgid, pgid, sid: REC.sid }, f.deps)).toBe('none')
      expect(f.sent).toEqual([])
    }
  })

  test('no record from spawn: nothing is signalled', async () => {
    const f = fake([[m(5001)]])
    expect(await endLeftovers(undefined, f.deps)).toBe('refused')
    expect(f.sent).toEqual([])
  })

  test('live members of the source session: TERM, then KILL only if they are still there', async () => {
    const gone = fake([[m(5001)], []])
    expect(await endLeftovers(REC, gone.deps)).toBe('ended')
    expect(gone.sent).toEqual(['SIGTERM -4242'])
    const stays = fake([[m(5001)], [m(5001)]])
    await endLeftovers(REC, stays.deps)
    expect(stays.sent).toEqual(['SIGTERM -4242', 'SIGKILL -4242'])
  })

  test('recordSpawn reads a detached child as its own session and group leader', async () => {
    const { spawn } = await import('node:child_process')
    const c = spawn('/bin/sleep', ['5'], { detached: true, stdio: 'ignore' })
    try {
      expect(await recordSpawn(c.pid)).toEqual({ pid: c.pid as number, pgid: c.pid as number, sid: c.pid as number })
    } finally {
      c.kill('SIGKILL')
    }
    expect(await recordSpawn(undefined)).toEqual({ why: 'no child was started' })
  })

  // A detached child becomes its own leader in the child: spawn can return while it still shows its parent's session and group.
  const notYet = (n: number, parent = { sid: 100, pgid: 100 }) => {
    let reads = 0
    return {
      reads: () => reads,
      deps: {
        getsid: (pid: number) => (++reads <= n ? parent.sid : pid),
        getpgid: (pid: number) => (reads <= n ? parent.pgid : pid),
        sleep: async () => {},
        everyMs: 10,
      },
    }
  }

  test('a child that shows its parent session at first is recorded once it is its own leader', async () => {
    const f = notYet(3)
    expect(await recordSpawn(4242, f.deps)).toEqual({ pid: 4242, pgid: 4242, sid: 4242 })
    expect(f.reads()).toBe(4)
  })

  test('a child that never becomes its own leader is not recorded: nothing is signalled, and the reason is logged', async () => {
    const f = notYet(Number.POSITIVE_INFINITY)
    const rec = await recordSpawn(4242, { ...f.deps, sleep: (ms) => Bun.sleep(ms), forMs: 50 })
    expect(rec).toEqual({ why: 'leader not yet in its own session after 50 ms' })
    const g = fake([[m(4243)]])
    expect(await endLeftovers(rec, g.deps)).toBe('refused')
    expect(g.sent).toEqual([])
    expect(g.lines).toEqual(['leftovers not checked: leader not yet in its own session after 50 ms'])
  })

  // The flake seen under load: a source over in a few ms is reaped before its first read. Its helper still runs in its session.
  test('a child gone before the first read is recorded as it was made, and its live group is still ended', async () => {
    const made = { pid: 4242, pgid: 4242, sid: 4242 }
    expect(await recordSpawn(4242, { getsid: () => undefined, getpgid: () => undefined })).toEqual(made)
    expect(await recordSpawn(4242, { ...notYet(1).deps, alive: () => false })).toEqual(made)
    const g = fake([[m(5001)], []]) // the helper, in the source's session
    expect(
      await endLeftovers(await recordSpawn(4242, { getsid: () => undefined, getpgid: () => undefined }), g.deps),
    ).toBe('ended')
    expect(g.sent).toEqual(['SIGTERM -4242'])
  })

  test('recorded as made, a group whose members are of another session (a reused number) is not signalled', async () => {
    const rec = await recordSpawn(4242, { getsid: () => undefined, getpgid: () => undefined })
    const g = fake([[m(5001)]], () => 9999)
    expect(await endLeftovers(rec, g.deps)).toBe('none')
    expect(g.sent).toEqual([])
  })

  test('reads that throw are no record, not a rejection', async () => {
    const boom = () => {
      throw new Error('ffi')
    }
    expect(await recordSpawn(4242, { getsid: boom, getpgid: boom })).toEqual({
      why: 'its session and group could not be read',
    })
  })

  test('a real source that leaves nothing behind: no signal at all', async () => {
    const pk = spyOn(process, 'kill')
    const lines: string[] = []
    try {
      const r = await runSource({
        argv: ['/bin/echo', 'hi'],
        env: { PATH: '/usr/bin:/bin' },
        stdin: '',
        timeoutMs: 5000,
        log: (l) => lines.push(l),
      })
      expect(r).toEqual({ ok: true, stdout: 'hi\n', stderr: '', code: 0 })
      for (const end = Date.now() + t(8000); !lines.length && Date.now() < end; ) await Bun.sleep(20)
      // the look at the group, just after the answer
      expect(lines).toEqual(['no leftovers'])
      expect(pk).not.toHaveBeenCalled()
    } finally {
      pk.mockRestore()
    }
  })
})
