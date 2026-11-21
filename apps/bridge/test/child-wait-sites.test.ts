// Every site that waits on a child (discovery, the Chronos adapter, a heartbeat source, runCommandAsync, `shortcuts sign`)
// against a child that exits while a grandchild keeps its output pipe open, so 'close' comes 30 s late: each settles in
// bounded time, reports what the child really did, and never signals the pid of a child that has exited (nor its group, but
// for a heartbeat source's group while it still has members of the source's session: heartbeat/leftovers.ts).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '@talos-app/testkit'
import type { BridgeEnv } from '../src/config.ts'
import { runSource } from '../src/heartbeat/spawn.ts'
import { runCommandAsync } from '../src/run-command.ts'
import { ChronosAdapter } from '../src/schedules/chronos-adapter.ts'
import { discover } from '../src/schedules/discovery.ts'
import { signWithShortcutsCli } from '../src/share/shortcut.ts'
import { heldPipeBin, heldPipeScript, killHeldPipes } from './held-pipe.ts'

let dir = ''
const pidFiles: string[] = []
const pidFile = () => {
  const f = join(dir, `gc-${pidFiles.length}`)
  pidFiles.push(f)
  return f
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talos-wait-child-'))
})
afterEach(() => {
  killHeldPipes(pidFiles.splice(0))
  rmSync(dir, { recursive: true, force: true })
})

/** Every signal sent while `f` runs: process.kill(pid) and ChildProcess#kill. */
async function signalsDuring<T>(f: () => Promise<T>): Promise<{ r: T; signals: unknown[][] }> {
  const signals: unknown[][] = []
  const pk = spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    signals.push(['process.kill', pid, sig])
    return true
  }) as typeof process.kill)
  const ck = spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (this: ChildProcess, sig?: unknown) {
    signals.push(['child.kill', this.pid, sig])
    return true
  })
  try {
    return { r: await f(), signals }
  } finally {
    pk.mockRestore()
    ck.mockRestore()
  }
}

/** The signals sent while `f` runs, passed through for real: [`process.kill` args], [`ChildProcess#kill` args]. */
async function realSignalsDuring<T>(f: () => Promise<T>): Promise<{ r: T; pk: unknown[][]; ck: unknown[][] }> {
  const pk = spyOn(process, 'kill')
  const ck = spyOn(ChildProcess.prototype, 'kill')
  try {
    const r = await f()
    return { r, pk: [...pk.mock.calls], ck: [...ck.mock.calls] }
  } finally {
    pk.mockRestore()
    ck.mockRestore()
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pidsIn = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .map(Number)
    .filter((n) => n > 0)

/** Every process.kill call was a group signal (TERM or KILL to a negative pid), or a probe of our own (signal 0). */
const groupSignalsOnly = (pk: unknown[][]) =>
  pk.every(([pid, sig]) => sig === 0 || ((pid as number) < 0 && (sig === 'SIGTERM' || sig === 'SIGKILL')))
const waitUntil = async (f: () => boolean, ms = t(3000)) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (f()) return
  expect(f()).toBe(true)
}

/** The command has written its grandchild's pid. */
const pidRecorded = (f: string) => {
  try {
    return pidsIn(f).length > 0
  } catch {
    return false // not written yet
  }
}

const elapsed = async <T>(f: () => Promise<T>) => {
  const t0 = Date.now()
  const r = await f()
  return { r, ms: Date.now() - t0 }
}

describe('discovery', () => {
  const env = (bin: string) =>
    ({
      scheduler: 'auto',
      chronosBin: bin,
      chronosAutoDiscover: false,
      chronosConfig: undefined,
      schedulerTimeoutMs: 5000,
      chronosNow: undefined,
      pathDirs: ['/usr/bin', '/bin'],
      userHome: dir,
      tz: 'UTC',
    }) as unknown as BridgeEnv
  const deps = (timeoutMs: number) =>
    ({
      meta: { threadOf: () => undefined, offerAgeS: () => null },
      now: () => Date.now(),
      clockIso: () => new Date().toISOString(),
      timeoutMs,
    }) as unknown as Parameters<typeof discover>[1]

  test(
    'an old Chronos whose `version` exits while a grandchild holds stdout is read as old, at once, with no signal',
    async () => {
      const pf = pidFile()
      const bin = heldPipeBin(
        dir,
        'chronos',
        pf,
        'if [ "$1" = api ]; then echo usage >&2; exit 2; fi; echo "chronos 0.2.2"',
      )
      const { r, signals } = await signalsDuring(() => elapsed(() => discover(env(bin), deps(3000))))
      expect(r.r.state).toBe('unsupported')
      expect(r.ms).toBeLessThan(t(5000))
      expect(signals).toEqual([])
    },
    t(20_000),
  )

  test(
    'a `version` still running at the deadline is unanswered, in bounded time (the schedule queue is never stuck)',
    async () => {
      const pf = pidFile()
      // the shell waits on a sleep that holds stdout: killing the shell alone would leave 'close' 30 s away
      const bin = join(dir, 'chronos')
      writeFileSync(
        bin,
        `#!/bin/sh\nif [ "$1" = api ]; then echo usage >&2; exit 2; fi\n/bin/sleep 30 & echo $! > '${pf}'; wait\n`,
        { mode: 0o755 },
      )
      const { r, pk, ck } = await realSignalsDuring(() => elapsed(() => discover(env(bin), deps(500))))
      expect(r.r.unanswered).toBe(true)
      expect(r.ms).toBeLessThan(t(4000))
      // Exactly one call was still running at its deadline and was killed: the stuck `version` (by pid), or, on a loaded Mac
      // where even the quick `api version` probe is still starting at 500 ms, that probe (by its group; then `version` never runs).
      const kills = [
        ...ck.filter(([sig]) => sig === 'SIGKILL').map(() => 'version'),
        ...pk.filter(([pid, sig]) => (pid as number) < 0 && sig === 'SIGKILL').map(() => 'api'),
      ]
      expect(kills.length).toBe(1)
      expect(ck.length + pk.filter(([, sig]) => sig !== 0).length).toBe(1) // nothing else signalled
    },
    t(20_000),
  )
})

describe('the Chronos adapter', () => {
  const adapter = (bin: string, timeoutMs: number) =>
    new ChronosAdapter({ bin, timeoutMs, env: { path: '/usr/bin:/bin' } })

  test(
    'a real answer from a call whose pipe a grandchild holds is the answer, not adapter_timeout, and nothing is signalled',
    async () => {
      const bin = heldPipeBin(dir, 'chronos', pidFile(), `echo '{"ok":true}'`)
      const { r, signals } = await signalsDuring(() => elapsed(() => adapter(bin, 3000).raw(['version'])))
      expect(r.r).toEqual({ ok: true })
      expect(r.ms).toBeLessThan(t(2500))
      expect(signals).toEqual([])
    },
    t(20_000),
  )

  test(
    'a call still running at its timeout is a timeout, and its group is killed while it runs',
    async () => {
      const pf = pidFile()
      const bin = join(dir, 'chronos')
      writeFileSync(bin, `#!/bin/sh\n/bin/sleep 30 & echo $! > '${pf}'; wait\n`, { mode: 0o755 })
      // 2 s: long enough on a loaded Mac for the shell to record its sleep before the timeout
      const { r, ms } = await elapsed(() =>
        adapter(bin, 2000)
          .raw(['version'])
          .then(
            () => 'answered',
            (e: { kind?: string }) => e.kind,
          ),
      )
      expect(r).toBe('timeout')
      expect(ms).toBeLessThan(t(5000))
      await waitUntil(() => pidsIn(pf).filter(alive).length === 0, t(8000))
      expect(pidsIn(pf).filter(alive)).toEqual([]) // the group went, grandchild too
    },
    t(20_000),
  )

  test(
    'shutdown mid-call kills the running call (its group) and the call settles',
    async () => {
      const pf = pidFile()
      const bin = join(dir, 'chronos')
      writeFileSync(bin, `#!/bin/sh\n/bin/sleep 30 & echo $! > '${pf}'; wait\n`, { mode: 0o755 })
      const a = adapter(bin, 10_000)
      const call = a.raw(['version']).then(
        () => 'answered',
        (e: { kind?: string }) => e.kind,
      )
      for (let i = 0; i < 200; i++) {
        await Bun.sleep(10)
        try {
          if (pidsIn(pf).length) break
        } catch {
          // not written yet
        }
      }
      const { r, ms } = await elapsed(async () => {
        a.close()
        return call
      })
      expect(r).toBe('parse') // killed: no JSON
      expect(ms).toBeLessThan(t(2000))
      await waitUntil(() => pidsIn(pf).filter(alive).length === 0, t(8000))
      expect(pidsIn(pf).filter(alive)).toEqual([])
    },
    t(20_000),
  )
})

describe('a heartbeat source', () => {
  test(
    'a source that succeeds while a grandchild holds stdout is a success, and the grandchild goes with its group',
    async () => {
      const pf = pidFile()
      const lines: string[] = []
      const { r, pk, ck } = await realSignalsDuring(async () => {
        const res = await elapsed(() =>
          runSource({
            argv: ['/bin/sh', '-c', heldPipeScript(pf)],
            env: { PATH: '/usr/bin:/bin' },
            stdin: '',
            timeoutMs: 2000,
            log: (l) => lines.push(l),
          }),
        )
        // the cleanup's own completion: it logs exactly one line when done (the time is only a hang cap)
        await waitUntil(() => lines.length > 0, t(20_000))
        return res
      })
      expect(r.r).toEqual({ ok: true, stdout: 'done\n', stderr: '', code: 0 })
      expect(r.ms).toBeLessThan(t(2000))
      expect(lines).toEqual(['leftovers ended'])
      expect(ck).toEqual([])
      expect(groupSignalsOnly(pk)).toBe(true) // never the reaped leader's own pid
      await waitUntil(() => pidsIn(pf).every((p) => !alive(p)), t(3000)) // TERMed (then KILLed) by the time it logged
    },
    t(30_000),
  )

  test(
    'a failing source whose pipe is held reports its own exit code',
    async () => {
      const r = await runSource({
        argv: ['/bin/sh', '-c', heldPipeScript(pidFile(), 'echo no', 4)],
        env: { PATH: '/usr/bin:/bin' },
        stdin: '',
        timeoutMs: 3000,
      })
      expect(r).toEqual({ ok: true, stdout: 'no\n', stderr: '', code: 4 })
    },
    t(20_000),
  )

  test(
    'its own timer firing inside the output grace of a source that has exited is not a timeout',
    async () => {
      const { r, pk } = await realSignalsDuring(() =>
        runSource({
          argv: ['/bin/sh', '-c', heldPipeScript(pidFile())],
          env: { PATH: '/usr/bin:/bin' },
          stdin: '',
          timeoutMs: 100, // well inside the 500 ms grace
        }),
      )
      expect(r).toEqual({ ok: true, stdout: 'done\n', stderr: '', code: 0 })
      expect(groupSignalsOnly(pk)).toBe(true)
    },
    t(20_000),
  )

  test(
    'an abort after the source exited never signals its pid; its leftovers still go with the live group',
    async () => {
      const ac = new AbortController()
      const pf = pidFile()
      const { r, pk, ck } = await realSignalsDuring(async () => {
        const p = runSource({
          argv: ['/bin/sh', '-c', `echo $$ > '${pf}.shell'; ${heldPipeScript(pf)}`],
          env: { PATH: '/usr/bin:/bin' },
          stdin: '',
          timeoutMs: 5000,
          signal: ac.signal,
        })
        // the shell has exited; its grandchild holds the pipe
        await waitUntil(() => pidRecorded(pf) && pidRecorded(`${pf}.shell`), t(5000))
        await waitUntil(() => !alive(pidsIn(`${pf}.shell`)[0] as number), t(5000))
        ac.abort()
        return p
      })
      expect(r).toEqual({ ok: false, reason: 'aborted', message: 'stopped' })
      await waitUntil(() => pidsIn(pf).every((p) => !alive(p)), t(8000))
      expect(ck).toEqual([])
      expect(groupSignalsOnly(pk)).toBe(true)
    },
    t(30_000),
  )

  test(
    'a source still running at its limit is a timeout, and its group is killed',
    async () => {
      const pf = pidFile()
      const r = await runSource({
        argv: ['/bin/sh', '-c', `/bin/sleep 30 & echo $! > '${pf}'; wait`],
        env: { PATH: '/usr/bin:/bin' },
        stdin: '',
        timeoutMs: 2000, // long enough on a loaded Mac for the shell to record its sleep first
      })
      expect(r).toMatchObject({ ok: false, reason: 'timeout' })
      await waitUntil(() => pidsIn(pf).filter(alive).length === 0, t(8000))
      expect(pidsIn(pf).filter(alive)).toEqual([])
    },
    t(20_000),
  )
})

describe('runCommandAsync (undo snapshot and restore)', () => {
  test(
    'without an abort it returns when the command exits, whatever its child holds, with its code and output',
    async () => {
      const { r, signals } = await signalsDuring(() =>
        elapsed(() => runCommandAsync(['/bin/sh', '-c', heldPipeScript(pidFile(), 'echo out; echo err >&2', 5)], dir)),
      )
      expect(r.r).toEqual({ code: 5, stdout: 'out', stderr: 'err' })
      expect(r.ms).toBeLessThan(t(3000))
      expect(signals).toEqual([])
    },
    t(20_000),
  )

  test(
    'an abort of a command that ignores SIGTERM still ends it, in bounded time',
    async () => {
      const pf = pidFile()
      const ac = new AbortController()
      const p = runCommandAsync(['/bin/sh', '-c', `trap '' TERM; /bin/sleep 30 & echo $! >> '${pf}'; wait`], dir, {
        signal: ac.signal,
      })
      await waitUntil(() => pidRecorded(pf), t(8000)) // the shell has started, with TERM ignored
      const { r, ms } = await elapsed(async () => {
        ac.abort()
        return p
      })
      expect(r.code).not.toBe(0)
      expect(ms).toBeLessThan(t(3000))
    },
    t(20_000),
  )
})

describe('shortcuts sign', () => {
  const withFakeShortcuts = async <T>(body: string, f: () => Promise<T>) => {
    writeFileSync(join(dir, 'shortcuts'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${dir}:/usr/bin:/bin`
    try {
      return await f()
    } finally {
      process.env.PATH = path
    }
  }

  test(
    'a signer that succeeds while a grandchild holds stderr is a success, at once, with no signal',
    async () => {
      const { r, signals } = await withFakeShortcuts(heldPipeScript(pidFile(), 'true'), () =>
        signalsDuring(() => elapsed(() => signWithShortcutsCli('in', 'out'))),
      )
      expect(r.r).toEqual({ ok: true })
      expect(r.ms).toBeLessThan(t(3000))
      expect(signals).toEqual([])
    },
    t(20_000),
  )

  test(
    'a signer that fails while its pipe is held reports its failure',
    async () => {
      const r = await withFakeShortcuts(heldPipeScript(pidFile(), 'echo nope >&2', 1), () =>
        signWithShortcutsCli('in', 'out'),
      )
      expect(r).toEqual({ ok: false, error: 'nope' })
    },
    t(20_000),
  )

  test(
    'a signer that never ends gives up at its deadline instead of hanging `talos-app share`',
    async () => {
      const pf = pidFile()
      const { r, ck } = await withFakeShortcuts(`/bin/sleep 30 & echo $! > '${pf}'; wait`, () =>
        realSignalsDuring(() => elapsed(() => signWithShortcutsCli('in', 'out', 300))),
      )
      expect(r.r).toEqual({ ok: false, error: expect.stringContaining('did not finish') })
      expect(r.ms).toBeLessThan(t(3000))
      expect(ck).toEqual([[]]) // the running signer, killed at its deadline
    },
    t(20_000),
  )
})
