// waitChild: settles on the first of close, exit plus a grace for close, the deadline, or a spawn error, in bounded time, with
// the child's own codes, and never signals anything itself.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { stillRunning, waitChild } from '../src/child-wait.ts'
import { killHeldPipes, trackPid } from './held-pipe.ts'

afterEach(() => killHeldPipes())

/** A shell that backgrounds a `sleep` holding its stdout, prints the sleep's pid and `done`, then exits with `code`. */
function exitsWhileGrandchildHoldsStdout(code = 0) {
  const child = spawn('/bin/sh', ['-c', `/bin/sleep 30 & echo $!; echo done; exit ${code}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.setEncoding('utf8').on('data', (d: string) => {
    out += d
    trackPid(Number(out.split('\n')[0]))
  })
  return { child, out: () => out }
}

describe('waitChild', () => {
  test('a normal child settles on close with its code and all its output', async () => {
    const child = spawn('/bin/sh', ['-c', 'echo hello; exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      out += d
    })
    const r = await waitChild(child, { deadlineMs: 5000 })
    expect(r).toEqual({ code: 3, signal: null, how: 'close' })
    expect(out).toBe('hello\n')
  })

  test('a child that exits while a grandchild holds its stdout settles after the grace, truthfully, with its output', async () => {
    const kill = spyOn(process, 'kill')
    try {
      const { child, out } = exitsWhileGrandchildHoldsStdout(0)
      const t0 = Date.now()
      const r = await waitChild(child, { graceMs: 200, deadlineMs: 10_000 })
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r).toEqual({ code: 0, signal: null, how: 'exit' })
      expect(out()).toContain('done\n')
      expect(kill).not.toHaveBeenCalled() // the helper never signals
    } finally {
      kill.mockRestore()
    }
  })

  test('the exit code of a child whose pipe is held is its own (a failure stays a failure)', async () => {
    const { child } = exitsWhileGrandchildHoldsStdout(7)
    const r = await waitChild(child, { graceMs: 100, deadlineMs: 10_000 })
    expect(r).toEqual({ code: 7, signal: null, how: 'exit' })
  })

  test('exit then close within the grace settles on close', async () => {
    // the grandchild lets go of the pipe 150 ms after the shell exits, inside a 2 s grace
    const child = spawn('/bin/sh', ['-c', '(/bin/sleep 0.15; echo late) & echo early'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      out += d
    })
    const r = await waitChild(child, { graceMs: 2000, deadlineMs: 10_000 })
    expect(r).toEqual({ code: 0, signal: null, how: 'close' })
    expect(out).toBe('early\nlate\n')
  })

  test('a child still running at the deadline settles with deadline and no made-up code', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      const t0 = Date.now()
      const r = await waitChild(child, { deadlineMs: 150 })
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(r).toEqual({ code: null, signal: null, how: 'deadline' })
      expect(stillRunning(child)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  test('a deadline inside the grace of an exited child is an exit, not a deadline', async () => {
    const { child } = exitsWhileGrandchildHoldsStdout(0)
    await new Promise((r) => child.once('exit', r))
    const r = await waitChild(child, { graceMs: 5000, deadlineMs: 100 })
    expect(r).toEqual({ code: 0, signal: null, how: 'exit' })
    expect(stillRunning(child)).toBe(false)
  })

  test('a command that cannot start settles with error', async () => {
    const child = spawn('/nonexistent/talos-wait-child', [], { stdio: 'ignore' })
    const r = await waitChild(child, { deadlineMs: 5000 })
    expect(r).toEqual({ code: null, signal: null, how: 'error' })
  })

  test('a killed child reports its signal', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    const p = waitChild(child, { deadlineMs: 5000 })
    child.kill('SIGKILL')
    expect(await p).toEqual({ code: null, signal: 'SIGKILL', how: 'close' })
  })
})
