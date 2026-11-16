// The takeover check (pure) and its Linux probes.
import { describe, expect, it } from 'bun:test'
import {
  argvHoldsChannels,
  checkTakeover,
  interactiveEntry,
  type Proc,
  parseAgents,
  procOf,
  type TakeoverInputs,
} from '../../src/supervisor/takeover.ts'

const proc = (pid: number, over: Partial<Proc> = {}): Proc => ({
  pid,
  pgid: pid,
  argv: ['claude'],
  cwd: `/home/alex/p${pid}`,
  startEpochS: 1000,
  ...over,
})
const base = (over: Partial<TakeoverInputs> = {}): TakeoverInputs => ({
  ourPgids: new Set([100]),
  botPid: null,
  bridgePid: null,
  agents: [],
  proc: () => null,
  ...over,
})

describe('claude agents --json', () => {
  it('reads the entries as Claude Code 2.1.322 prints them; anything else is unreadable', () => {
    const text = JSON.stringify([
      {
        pid: 11385,
        cwd: '/home/alex',
        kind: 'interactive',
        startedAt: 1,
        sessionId: 's1',
        name: 'Hestia',
        status: 'busy',
      },
      { pid: 'x', kind: 'background' },
      'junk',
    ])
    const list = parseAgents(text)
    expect(list).toEqual([
      { kind: 'interactive', pid: 11385, sessionId: 's1', status: 'busy', cwd: '/home/alex' },
      { kind: 'background', pid: null, sessionId: null, status: null, cwd: null },
    ])
    expect(interactiveEntry(list ?? [], 11385)?.sessionId).toBe('s1')
    expect(
      parseAgents(JSON.stringify({ agents: [{ kind: 'interactive', pid: 3, sessionId: 'ABC' }] }))?.[0]?.sessionId,
    ).toBe('abc')
    expect(parseAgents(JSON.stringify({ sessions: [] }))).toEqual([])
    expect(parseAgents('not json')).toBeNull()
    expect(parseAgents('{}')).toBeNull()
  })
})

describe('the takeover check', () => {
  it('an interactive claude elsewhere with the Talos channel blocks; one without it, or ours, does not', () => {
    const procs: Record<number, Proc> = {
      200: proc(200, { argv: ['claude', '--dangerously-load-development-channels', 'server:talos-app'] }),
      300: proc(300, { argv: ['claude', '--model', 'opus'] }),
      100: proc(100, { argv: ['claude', '--channels', 'server:talos-app'] }),
    }
    const agents = [200, 300, 100].map((pid) => ({
      kind: 'interactive',
      pid,
      sessionId: null,
      status: null,
      cwd: null,
    }))
    const b = checkTakeover(base({ agents, proc: (p) => procs[p] ?? null }))
    expect(b).toEqual([{ resource: 'channels', holderPid: 200, sessionPid: 200, folder: '/home/alex/p200' }])
    expect(checkTakeover(base({ agents: null, proc: (p) => procs[p] ?? null }))).toEqual([]) // unreadable: skipped
  })
  it('a live bridge of another session blocks; one in our group, or a stale record, does not', () => {
    const record = { pid: 400, started_at: 'linux:abc:1', instance: 'i' }
    const holder = proc(400, { pgid: 401, argv: ['bun', 'apps/bridge/src/server.ts'] })
    const g = (p: number) => (p === 401 ? proc(401) : null)
    expect(checkTakeover(base({ bridgePid: { record, ours: true, holder }, proc: g }))[0]).toMatchObject({
      resource: 'bridge',
      sessionPid: 401,
      folder: '/home/alex/p401',
    })
    expect(checkTakeover(base({ bridgePid: { record, ours: false, holder }, proc: g }))).toEqual([])
    expect(
      checkTakeover(base({ ourPgids: new Set([401]), bridgePid: { record, ours: true, holder }, proc: g })),
    ).toEqual([])
  })
  it('Telegram’s bot.pid holder blocks only when it is that poller and started before the file was written', () => {
    const holder = proc(500, { pgid: 501, argv: ['bun', 'server.ts'], startEpochS: 1000 })
    expect(checkTakeover(base({ botPid: { pid: 500, fileModifiedAtS: 1001, holder } }))[0]?.resource).toBe('telegram')
    // a recycled pid: the process now there started well after the file was written (60 s slack on Linux)
    expect(checkTakeover(base({ botPid: { pid: 500, fileModifiedAtS: 930, holder } }))).toEqual([])
    expect(checkTakeover(base({ botPid: { pid: 500, fileModifiedAtS: 945, holder } }))[0]?.resource).toBe('telegram')
    expect(
      checkTakeover(base({ botPid: { pid: 500, fileModifiedAtS: 1001, holder: { ...holder, argv: ['vim'] } } })),
    ).toEqual([])
  })
  it('the channel flag in every form', () => {
    expect(argvHoldsChannels(['--channels', 'plugin:telegram'])).toBe(true)
    expect(argvHoldsChannels(['--channels=plugin:x'])).toBe(true)
    expect(argvHoldsChannels(['--dangerously-load-development-channels', 'a,server:talos-app'])).toBe(true)
    expect(argvHoldsChannels(['--model', 'opus'])).toBe(false)
  })
})

describe('/proc', () => {
  it('reads a process from fake /proc text (runs everywhere): a comm with spaces and a `)`, boot time plus ticks', () => {
    const files: Record<string, string> = {
      '/proc/4242/stat': '4242 (my (odd) name) S 1 4240 4240 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0',
      '/proc/stat': 'cpu  1 2 3\nbtime 1700000000\nprocesses 9\n',
      '/proc/4242/cmdline': 'bun\0apps/bridge/src/server.ts\0',
    }
    const read = (p: string) => {
      const v = files[p]
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    }
    expect(procOf(4242, read)).toMatchObject({
      pid: 4242,
      pgid: 4240,
      argv: ['bun', 'apps/bridge/src/server.ts'],
      startEpochS: 1700000000 + 123.45,
    })
    expect(procOf(4243, read)).toBeNull()
  })
  it.skipIf(process.platform !== 'linux')(
    'reads this very process (Linux /proc): its group, argv, folder and a start time in the past',
    () => {
      const me = procOf(process.pid)
      expect(me?.pid).toBe(process.pid)
      expect(me?.argv.length).toBeGreaterThan(0)
      expect(me?.cwd).toBe(process.cwd())
      expect(me?.startEpochS).toBeLessThanOrEqual(Date.now() / 1000 + 1)
      expect(me?.startEpochS).toBeGreaterThan(Date.now() / 1000 - 3600)
      expect(procOf(1)).toBeNull()
      expect(procOf(999_999_999)).toBeNull()
    },
  )
})

describe('the blocker text', () => {
  it('never offers --anyway for Telegram', async () => {
    const { blockerText } = await import('../../src/supervisor/takeover.ts')
    expect(blockerText({ resource: 'telegram', holderPid: 1, sessionPid: 2, folder: null })).not.toContain('--anyway')
    expect(blockerText({ resource: 'channels', holderPid: 1, sessionPid: 2, folder: '/x' })).toContain('--anyway')
  })
})
