// Process identity (src/proc-identity.ts): the start-time token every kill and takeover check compares. On Linux it must come
// from /proc, never from ps: WSL's ps prints a start time that drifts, and a drifting one made a live owner look recycled.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processInfo } from '../src/heartbeat/spawn.ts'
import { isOurBridge, psInfo } from '../src/lifecycle.ts'
import { comparableStarts, parseProcStat, processGroup, processStartTime } from '../src/proc-identity.ts'
import { InstanceRegistry } from '../src/schedules/instances.ts'

const linux = process.platform === 'linux'
const realPath = process.env.PATH
const dirs: string[] = []
afterEach(() => {
  process.env.PATH = realPath
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A `ps` first on PATH that prints a new start time on every call, as WSL's drifting boot clock does, then `cmd`. */
function driftingPs(cmd: string) {
  const d = mkdtempSync(join(tmpdir(), 'ps-drift-'))
  dirs.push(d)
  mkdirSync(join(d, 'bin'))
  writeFileSync(
    join(d, 'bin', 'ps'),
    `#!/bin/sh\nn=$(cat "${d}/n" 2>/dev/null || echo 10); echo $((n+1)) > "${d}/n"\necho "Tue Nov 10 17:43:$n 2026 ${cmd}"\n`,
  )
  chmodSync(join(d, 'bin', 'ps'), 0o755)
  process.env.PATH = `${join(d, 'bin')}:${realPath}`
}

// A stat line whose command holds spaces and a `)`: only counting from the last `)` finds the right fields.
const STAT = '4242 (we ird) (cmd) S 1 4240 4240 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200'

describe('parseProcStat', () => {
  test('counts fields from the last parenthesis, so a command with spaces or ) is read right', () => {
    expect(parseProcStat(STAT)).toEqual({ pgid: 4240, startTicks: '987654' })
  })
  test('a cut-off or foreign line is no answer', () => {
    expect(parseProcStat('4242 (sh) S 1')).toBeNull()
    expect(parseProcStat('no parenthesis here')).toBeNull()
  })
})

describe('processStartTime', () => {
  const read = (files: Record<string, string>) => (p: string) => {
    const f = files[p]
    if (f === undefined) throw new Error('ENOENT')
    return f
  }
  test('Linux: the boot id and the start ticks, never ps', () => {
    const r = read({
      '/proc/4242/stat': STAT,
      '/proc/sys/kernel/random/boot_id': '0f3c9a1e-77b2-4c1d-9e0a-5b6c7d8e9f01\n',
    })
    expect(processStartTime(4242, { platform: 'linux', read: r })).toBe('linux:0f3c9a1e77b2:987654')
    expect(processGroup(4242, { platform: 'linux', read: r })).toBe(4240)
  })
  test('Linux: a pid /proc does not know is null, not a guess', () => {
    const r = read({ '/proc/sys/kernel/random/boot_id': 'abc' })
    expect(processStartTime(4242, { platform: 'linux', read: r })).toBeNull()
    expect(processGroup(4242, { platform: 'linux', read: r })).toBeNull()
  })
  test('not a pid: null', () => {
    expect(processStartTime(0)).toBeNull()
    expect(processStartTime(-1)).toBeNull()
    expect(processStartTime(1.5)).toBeNull()
  })
  test('a live process keeps one token; another process has another; a gone one has none', () => {
    const me = processStartTime(process.pid)
    expect(me).not.toBeNull()
    for (let i = 0; i < 50; i++) expect(processStartTime(process.pid)).toBe(me)
    const child = Bun.spawn(['sleep', '5'])
    try {
      // macOS's lstart has one-second steps: a child started in the same second shows the same text
      if (linux) expect(processStartTime(child.pid)).not.toBe(me)
      expect(processGroup(process.pid)).toBeGreaterThan(0)
    } finally {
      child.kill('SIGKILL')
    }
    expect(processStartTime(2_000_000_000)).toBeNull()
  })
})

describe('a start time written before Linux read /proc', () => {
  const token = 'linux:0f3c9a1e77b2:987654'
  const psText = 'Tue Nov 10 17:43:42 2026'
  test('is not comparable with a /proc token, either way round; two of a kind are', () => {
    expect(comparableStarts(token, psText)).toBe(false)
    expect(comparableStarts(psText, token)).toBe(false)
    expect(comparableStarts(token, 'linux:0f3c9a1e77b2:1')).toBe(true)
    expect(comparableStarts(psText, 'Wed Nov 11 09:00:00 2026')).toBe(true)
  })
  test('an older pid file still finds its live bridge by ps text, and only by the same text', () => {
    const cmd = 'bun run /x/apps/bridge/src/server.ts'
    const rec = { pid: 4242, started_at: psText, instance: 'x' }
    expect(isOurBridge(rec, () => ({ lstart: token, psLstart: psText, command: cmd }))).toBe(true)
    expect(isOurBridge(rec, () => ({ lstart: token, psLstart: 'Thu Oct 29 09:00:00 2026', command: cmd }))).toBe(false)
    // a pid file that holds a token is only ever compared as a token
    const now = { ...rec, started_at: token }
    expect(isOurBridge(now, () => ({ lstart: 'linux:0f3c9a1e77b2:5', psLstart: token, command: cmd }))).toBe(false)
  })
  test('the instance registry reads an older live owner as alive, not as a recycled pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inst-'))
    dirs.push(dir)
    const reg = new InstanceRegistry(dir, { startedAt: () => psText, running: () => true, host: () => 'h' })
    reg.register('bi_old')
    const now = new InstanceRegistry(dir, { startedAt: () => token, running: () => true, host: () => 'h' })
    expect(now.stateOf('bi_old')).toBe('alive')
    const recycled = new InstanceRegistry(dir, {
      startedAt: () => 'Thu Oct 29 09:00:00 2026',
      running: () => true,
      host: () => 'h',
    })
    expect(recycled.stateOf('bi_old')).toBe('gone')
  })
})

describe.if(linux)('Linux: a ps whose start time drifts changes nothing', () => {
  test('psInfo reads the start from /proc, so our own bridge is still ours on the second look', () => {
    driftingPs('bun run /x/apps/bridge/src/server.ts')
    const first = psInfo(process.pid)
    expect(first?.command).toContain('apps/bridge/src/server.ts') // the command still comes from ps
    const rec = { pid: process.pid, started_at: first?.lstart ?? '', instance: 'x' }
    expect(isOurBridge(rec)).toBe(true)
    expect(rec.started_at).toBe(processStartTime(process.pid) as string)
  })
  test('processInfo reads the start from /proc, so a heartbeat source is not taken for a stranger', async () => {
    driftingPs('/bin/sleep 1')
    const a = await processInfo(process.pid)
    const b = await processInfo(process.pid)
    expect(typeof a).toBe('object')
    expect(a).toEqual(b)
  })
})
