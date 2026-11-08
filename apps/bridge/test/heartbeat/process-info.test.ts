// HB L7: reading a source's start time with `ps` must not stop the bridge's event loop. A fake `ps` that takes a while stands in
// for a slow machine; the real `ps` is used for the answer shapes.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processInfo, runSource } from '../../src/heartbeat/spawn.ts'

const realPath = process.env.PATH
const dirs: string[] = []
afterEach(() => {
  process.env.PATH = realPath
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Puts a `ps` first on PATH that runs `body` (sh). */
function fakePs(body: string) {
  const d = mkdtempSync(join(tmpdir(), 'ps-'))
  dirs.push(d)
  mkdirSync(join(d, 'bin'))
  writeFileSync(join(d, 'bin', 'ps'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(d, 'bin', 'ps'), 0o755)
  process.env.PATH = `${join(d, 'bin')}:${realPath}`
}

/** How many times a 20 ms timer fired while `work` ran. */
async function ticksDuring(work: Promise<unknown>): Promise<number> {
  let n = 0
  const t = setInterval(() => n++, 20)
  try {
    await work
  } finally {
    clearInterval(t)
  }
  return n
}

describe('processInfo', () => {
  test('answers for a live process and for one that is gone', async () => {
    const me = await processInfo(process.pid)
    expect(typeof me).toBe('object')
    if (typeof me === 'object') expect(me.command.length).toBeGreaterThan(0)
    expect(await processInfo(2_000_000)).toBe('gone')
  })

  test('a slow ps does not stop the event loop', async () => {
    fakePs('sleep 0.6; echo "Mon Jan  1 00:00:00 2001 /bin/sleep 1"')
    const p = processInfo(4242)
    const ticks = await ticksDuring(p)
    expect(await p).toEqual({ lstart: 'Mon Jan  1 00:00:00 2001', command: '/bin/sleep 1' })
    expect(ticks).toBeGreaterThanOrEqual(10) // 0.6 s of 20 ms ticks: a blocked loop gets none
  })

  test('a ps that never answers is unknown after the timeout, not gone', async () => {
    fakePs('exec sleep 30')
    const t0 = Date.now()
    expect(await processInfo(4242, { timeoutMs: 300 })).toBe('unknown')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test('a ps that cannot run at all is unknown', async () => {
    process.env.PATH = '/nonexistent-dir'
    expect(await processInfo(4242)).toBe('unknown')
  })

  test('starting a source with a slow ps does not stall the loop, and the source still gets its input', async () => {
    fakePs('sleep 0.6; /bin/ps "$@"')
    let started = 0
    const run = runSource({
      argv: ['/bin/cat'],
      env: { PATH: '/bin:/usr/bin' },
      stdin: 'hello',
      timeoutMs: 10_000,
      onStart: () => started++,
    })
    const ticks = await ticksDuring(run)
    const r = await run
    expect(r.ok && r.stdout).toBe('hello')
    expect(started).toBe(1)
    expect(ticks).toBeGreaterThanOrEqual(10)
  })

  test("the time ps takes is not charged to the source's limit", async () => {
    fakePs('sleep 0.7; /bin/ps "$@"')
    // the source answers as soon as it has its input, which only comes after ps: its 400 ms limit is longer than it needs
    const r = await runSource({
      argv: ['/bin/cat'],
      env: { PATH: '/bin:/usr/bin' },
      stdin: 'hi',
      timeoutMs: 400,
      onStart: () => {},
    })
    expect(r.ok && r.stdout).toBe('hi')
  })

  test('a source that really is too slow is still stopped at its limit', async () => {
    const t0 = Date.now()
    const r = await runSource({ argv: ['/bin/sleep', '30'], env: { PATH: '/bin:/usr/bin' }, stdin: '', timeoutMs: 300 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
