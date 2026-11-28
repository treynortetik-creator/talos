// FakeClaude.stop() returns only when the child process is really gone: the MCP SDK's close() SIGKILLs without waiting for the
// exit, so a child still writing into the folder made rmSync fail with ENOTEMPTY (e2e/harness/stack.ts stop(),
// 09-security-surface.spec.ts). It waits on the child PROCESS OBJECT, never on a bare pid: Node reaps a child at once and the same
// number can belong to another process of ours a moment later, which must never be signalled.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClaude } from '../src/fake-claude.ts'
import { type ChildLike, waitForChildGone } from '../src/process-wait.ts'
import { t } from '../src/time-factor.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const cleanup: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of cleanup.splice(0)) f()
})
const track = (child: ReturnType<typeof spawn>) => {
  cleanup.push(() => child.kill('SIGKILL'))
  return child
}
const exitedChild = async () => {
  const c = track(spawn('true', { stdio: 'ignore' }))
  await new Promise((r) => c.once('exit', r))
  return c
}
const bridgeClaude = () =>
  new FakeClaude({ command: 'bun', args: ['run', '/nonexistent/apps/bridge/src/server.ts'], env: {} })
type Inner = { transport: Record<string, unknown>; client: { close: () => Promise<void> } }

describe('FakeClaude.stop waits for the process to exit', () => {
  it(
    'a child that takes a while to die after the close is gone when stop() returns, and nothing writes into its folder any more',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'talos-stop-wait-'))
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
      // a "bridge": on SIGTERM it takes 0.4 s to finish, writing into its folder until then
      const child = track(
        spawn(
          'sh',
          [
            '-c',
            `trap 'for i in 1 2 3 4 5 6 7 8; do echo x >> "${dir}/log"; sleep 0.05; done; exit 0' TERM; while :; do sleep 0.05; done`,
          ],
          { stdio: 'ignore' },
        ),
      )
      const pid = child.pid as number
      const claude = bridgeClaude()
      // what the SDK's close() does: signal the child and return at once, without waiting for it to exit
      const inner = claude as unknown as Inner
      inner.transport = { pid, _process: child }
      inner.client = { close: async () => void child.kill('SIGTERM') }
      await new Promise((r) => setTimeout(r, t(100))) // the trap is set
      await claude.stop()
      expect(alive(pid), 'the child was still running when stop() returned').toBe(false)
    },
    t(30_000),
  )

  it(
    'a child that has already exited is not waited for, and a process that now has its number is never signalled',
    async () => {
      // the child is gone and its pid number has been handed to another process of ours (simulated by the decoy's number)
      const decoy = track(spawn('sleep', ['60'], { stdio: 'ignore' }))
      const gone = await exitedChild()
      const kill = vi.spyOn(process, 'kill')
      const claude = bridgeClaude()
      const inner = claude as unknown as Inner
      inner.transport = { pid: decoy.pid, _process: gone }
      inner.client = { close: async () => {} }
      const started = Date.now()
      await claude.stop()
      expect(Date.now() - started, 'it waited for a child that had already exited').toBeLessThan(t(2000))
      expect(kill.mock.calls.filter((c) => c[0] === decoy.pid)).toEqual([])
      expect(alive(decoy.pid as number), 'a process that is not the child was killed').toBe(true)
    },
    t(30_000),
  )

  it(
    'with no child object to read it only looks at the number, and never signals it',
    async () => {
      const other = track(spawn('sh', ['-c', 'sleep 0.3'], { stdio: 'ignore' }))
      const kill = vi.spyOn(process, 'kill')
      const claude = bridgeClaude()
      const inner = claude as unknown as Inner
      inner.transport = { pid: other.pid } // no _process: the SDK's field is not there
      inner.client = { close: async () => {} }
      await claude.stop()
      expect(alive(other.pid as number)).toBe(false) // waited until it was gone on its own
      expect(kill.mock.calls.filter((c) => c[1] !== 0)).toEqual([]) // looked (signal 0) but never sent a real signal
    },
    t(30_000),
  )
})

describe('waitForChildGone', () => {
  const stub = (over: Partial<ChildLike> = {}): ChildLike & { kill: ReturnType<typeof vi.fn> } =>
    ({ exitCode: null, signalCode: null, kill: vi.fn(() => true), ...over }) as never

  it('an exited child (exit code or signal) is neither waited for nor signalled', async () => {
    for (const over of [{ exitCode: 0 }, { signalCode: 'SIGKILL' }]) {
      const c = stub(over)
      const started = Date.now()
      expect(await waitForChildGone(c, t(10_000))).toBe(true)
      expect(Date.now() - started).toBeLessThan(t(500))
      expect(c.kill).not.toHaveBeenCalled()
    }
  })

  it('a child still running after the bound gets one SIGKILL through its object, and is waited for again', async () => {
    const c = stub()
    c.kill.mockImplementation(() => {
      c.signalCode = 'SIGKILL'
      return true
    })
    expect(await waitForChildGone(c, 60)).toBe(true)
    expect(c.kill).toHaveBeenCalledTimes(1)
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('a child that exits by itself inside the bound is never killed', async () => {
    const c = stub()
    setTimeout(() => {
      c.exitCode = 0
    }, 80)
    expect(await waitForChildGone(c, 2000)).toBe(true)
    expect(c.kill).not.toHaveBeenCalled()
  })
})
