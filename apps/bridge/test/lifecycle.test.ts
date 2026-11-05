import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64urlDecode, bridgeKeyId, parseBridgeAuthHeader, verifyRotation } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { Bridge, type Bridge as BridgeT } from '../src/bridge.ts'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { BRIDGE_ENTRY, isOurBridge, type PidRecord, takeOver } from '../src/lifecycle.ts'
import { createLogger, nullLogger } from '../src/log.ts'
import { problemDirs } from '../src/problems/store.ts'
import { backoffMs } from '../src/relay-client.ts'
import { advanceSteps, type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const cliIO = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
  }
}

describe('reconnect', () => {
  test('backoff sequence 1, 2, 5, 10, 30 s then every 60 s, with +/-20% jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((i) => backoffMs(i, () => 0.5))).toEqual([
      1000, 2000, 5000, 10_000, 30_000, 60_000, 60_000, 60_000,
    ])
    for (const i of [0, 1, 2, 3, 4, 5]) {
      const base = [1000, 2000, 5000, 10_000, 30_000, 60_000][i] as number
      expect(backoffMs(i, () => 0)).toBe(Math.round(base * 0.8))
      expect(backoffMs(i, () => 0.999999)).toBeLessThanOrEqual(Math.round(base * 1.2))
    }
  })

  test('after a dropped connection the bridge reconnects after the first backoff step and resends nothing twice', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock, bridge: { random: () => 0.5 } })
    const hellos = () => h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'hello').length
    expect(hellos()).toBe(1)
    h.relay.dropBridge()
    await waitFor(() => !h.relay.bridgeConnected)
    await sleep(50)
    await advanceSteps(clock, 900, 300)
    expect(h.relay.bridgeConnected).toBe(false)
    await advanceSteps(clock, 200, 100)
    await waitFor(() => h.relay.bridgeConnected, 3000, 'reconnect')
    expect(hellos()).toBe(2)
  })

  test('on 4409 the bridge never reconnects: it goes headless for the rest of the process and tells the agent', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    expect(h.bridge.live).toBe(true)
    h.relay.kickBridge(4409)
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.kind).toBe('system')
    expect(h.notes[0]?.content).toContain('Another bridge connected')
    expect(h.bridge.live).toBe(false)
    await sleep(1400) // longer than the 0.8 s first backoff step
    expect(h.relay.bridgeConnected).toBe(false)
    expect(h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'hello')).toHaveLength(1)
    // replies still work, over signed HTTP
    const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'still here' })
    expect(res.isError).toBeFalsy()
    expect(h.relay.http.some((r) => r.path === '/bridge/post' && r.status === 200)).toBe(true)
  })

  test('a superseded bridge stops filing its own errors, so two processes never write one problem folder', async () => {
    const log = createLogger(null, 'error', () => {})
    h = await startHarness({ bridge: { random: () => 0, logger: log } })
    h.relay.kickBridge(4409)
    await h.waitNotes(1)
    log.error('something broke after the takeover', { error: 'x' })
    await sleep(100)
    expect(existsSync(problemDirs(h.home).open)).toBe(false)
  })

  test('a superseded bridge also stops the problem service timer', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    const svc = h.bridge.ctx.problems as unknown as { timer: unknown }
    expect(svc.timer).not.toBeNull() // running while live
    h.relay.kickBridge(4409)
    await h.waitNotes(1)
    expect(svc.timer).toBeNull()
  })

  // The fake clock keeps the reconnect timer from firing, so the socket stays down for as long as the test needs.
  test('a reply written while the socket is down goes out over signed HTTP at once and is not queued', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock, bridge: { random: () => 0.5 } })
    h.relay.dropBridge()
    await waitFor(() => h.bridge.client?.connected === false, 4000, 'the bridge to notice the dropped socket')
    const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'sent while the socket was down' })
    expect(res.content[0]?.text).toMatch(/^sent/)
    expect(h.relay.http.some((r) => r.path === '/bridge/post' && r.status === 200)).toBe(true)
    await h.relay.expectFrame('reply', (f) => f.message.text === 'sent while the socket was down', {
      direction: 'from_bridge',
    })
    expect(h.bridge.ctx.store.outboxCount()).toBe(0)
  })

  test('with the socket and the HTTP path both down, the reply is queued and the outbox resends it after reconnect', async () => {
    const clock = fakeClock(new Date().toISOString())
    // Only the signed POST of a frame fails; everything else the bridge asks the relay over HTTP still works.
    const fetchFn = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      String(input).includes('/bridge/post')
        ? Promise.reject(new Error('network is down'))
        : fetch(input, init)) as typeof fetch
    h = await startHarness({ clock, bridge: { random: () => 0.5, fetchFn } })
    h.relay.dropBridge()
    await waitFor(() => h.bridge.client?.connected === false, 4000, 'the bridge to notice the dropped socket')
    const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'queued while everything was down' })
    expect(res.content[0]?.text).toMatch(/^queued/)
    expect(h.bridge.ctx.store.outboxCount()).toBeGreaterThan(0)
    // Reconnect. HTTP posting never works in this test, so only the outbox resend can deliver the reply.
    await advanceSteps(clock, 1100, 100)
    await waitFor(() => h.relay.bridgeConnected, 3000, 'reconnect')
    await h.relay.expectFrame('reply', (f) => f.message.text === 'queued while everything was down', {
      direction: 'from_bridge',
    })
    await waitFor(() => h.bridge.ctx.store.outboxCount() === 0, 4000, 'the resent reply acked')
    expect(h.relay.http.some((r) => r.path === '/bridge/post')).toBe(false)
  })
})

describe('single bridge (PID file)', () => {
  const rec: PidRecord = { pid: 4242, started_at: 'Wed Oct 28 18:04:37 2026', instance: 'abcdef0123456789' }

  test('only a pid with the same start time AND a command containing apps/bridge/src/server.ts counts as our bridge', () => {
    const cmd = `bun run /opt/talos-app/${BRIDGE_ENTRY}`
    expect(isOurBridge(rec, () => ({ lstart: rec.started_at, command: cmd }))).toBe(true)
    expect(isOurBridge(rec, () => ({ lstart: 'Thu Oct 29 09:00:00 2026', command: cmd }))).toBe(false) // pid reused later
    expect(isOurBridge(rec, () => ({ lstart: rec.started_at, command: 'bun run /opt/other/server.ts' }))).toBe(false)
    expect(isOurBridge(rec, () => undefined)).toBe(false)
  })

  test('takeOver sends SIGTERM to a matching bridge and to nothing else', async () => {
    const home = tempHome()
    const p = paths(home)
    writeFileSync(p.pid, JSON.stringify(rec))
    const killed: Array<[number, string]> = []
    const matching = await takeOver(p, nullLogger, {
      ps: () => ({ lstart: rec.started_at, command: `bun run /x/${BRIDGE_ENTRY}` }),
      kill: (pid, sig) => killed.push([pid, sig]),
      alive: () => false,
      sleep: async () => {},
      selfPid: 1,
    })
    expect(matching).toBe('stopped')
    expect(killed).toEqual([[4242, 'SIGTERM']])
    killed.length = 0
    for (const ps of [
      () => ({ lstart: 'Thu Oct 29 09:00:00 2026', command: `bun run /x/${BRIDGE_ENTRY}` }),
      () => ({ lstart: rec.started_at, command: 'vim notes.txt' }),
      () => undefined,
    ]) {
      expect(await takeOver(p, nullLogger, { ps, kill: (pid, sig) => killed.push([pid, sig]), selfPid: 1 })).toBe(
        'left_alone',
      )
    }
    expect(killed).toEqual([])
  })

  test('a real, live process whose start time or command does not match is never killed', async () => {
    const home = tempHome()
    const p = paths(home)
    const victim = Bun.spawn(['sleep', '30'])
    try {
      writeFileSync(p.pid, JSON.stringify({ pid: victim.pid, started_at: 'Mon Jan  1 00:00:00 2001', instance: 'x' }))
      expect(await takeOver(p, nullLogger, { selfPid: 1 })).toBe('left_alone')
      const real = (await import('../src/lifecycle.ts')).psInfo(victim.pid)
      writeFileSync(p.pid, JSON.stringify({ pid: victim.pid, started_at: real?.lstart ?? '', instance: 'x' }))
      expect(await takeOver(p, nullLogger, { selfPid: 1 })).toBe('left_alone') // right start time, wrong command
      await sleep(100)
      expect(victim.killed).toBe(false)
      expect(victim.exitCode).toBeNull()
    } finally {
      victim.kill('SIGKILL')
    }
  })

  test('a real process with the right start time and an apps/bridge/src/server.ts command line is stopped with SIGTERM', async () => {
    const home = tempHome()
    const p = paths(home)
    const proc = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)', '--', `/opt/talos-app/${BRIDGE_ENTRY}`])
    try {
      await sleep(150)
      const info = (await import('../src/lifecycle.ts')).psInfo(proc.pid)
      expect(info?.command).toContain(BRIDGE_ENTRY)
      writeFileSync(p.pid, JSON.stringify({ pid: proc.pid, started_at: info?.lstart, instance: 'x' }))
      expect(await takeOver(p, nullLogger, { selfPid: 1 })).toBe('stopped')
      await proc.exited
      expect(proc.signalCode).toBe('SIGTERM')
    } finally {
      proc.kill('SIGKILL')
    }
  })
})

describe('key rotation', () => {
  test('rotate POSTs /bridge/rotate signed by the OLD key, swaps bridge.key atomically, keeps .prev, and the live bridge reconnects with the new key without a 4409', async () => {
    h = await startHarness({ relay: { bridgeAuth: 'off' } })
    const p = paths(h.home)
    const oldKey = JSON.parse(readFileSync(p.bridgeKey, 'utf8'))
    const { out, err, io } = cliIO()
    const code = await runCli(['rotate'], io, { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl })
    expect(err).toEqual([])
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('rotated')
    const req = h.relay.http.find((r) => r.path === '/bridge/rotate')
    expect(req?.method).toBe('POST')
    expect(parseBridgeAuthHeader(String(req?.headers.authorization))?.keyId).toBe(oldKey.key_id)
    const body = JSON.parse(req?.body.toString() ?? '{}')
    expect(await verifyRotation(body.new_pubkey, body.ts, body.sig_new)).toBe(true)
    const newKey = JSON.parse(readFileSync(p.bridgeKey, 'utf8'))
    expect(newKey.public).toBe(body.new_pubkey)
    // D58: the owner is told to put the NEW key in Railway, with the exact line, and that Railway holds the old one.
    expect(out).toContain(`BRIDGE_PUBKEY=${body.new_pubkey}`)
    expect(out.join('\n')).toMatch(/Railway still trusts the OLD key/)
    expect(newKey.key_id).toBe(bridgeKeyId(b64urlDecode(body.new_pubkey)))
    expect(JSON.parse(readFileSync(p.bridgeKeyPrev, 'utf8')).key_id).toBe(oldKey.key_id)
    const left = readdirSync(h.home).filter((f) => f.endsWith('.tmp') || f === 'bridge.key.next')
    expect(left).toEqual([])
    for (const f of ['bridge.key', 'bridge.key.prev']) expect(statSync(join(h.home, f)).mode & 0o777).toBe(0o600)
    // the live bridge notices the new file and reconnects with the new key
    await h.bridge.poll()
    await waitFor(
      () =>
        h.relay.frames.some(
          (r) =>
            r.direction === 'from_bridge' &&
            r.frame.type === 'hello' &&
            (r.frame as { key_id: string }).key_id === newKey.key_id,
        ),
      4000,
      'hello with the new key',
    )
    await waitFor(() => h.relay.bridgeConnected)
    expect(h.bridge.live).toBe(true)
    expect(h.notes.filter((n) => n.meta.kind === 'system')).toEqual([]) // no supersede notice
  })

  test('a failed rotation leaves bridge.key untouched', async () => {
    h = await startHarness({ startBridge: false })
    const p = paths(h.home)
    const before = readFileSync(p.bridgeKey, 'utf8')
    const { err, io } = cliIO()
    const code = await runCli(['rotate'], io, { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: 'http://127.0.0.1:1' })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('bridge.key is unchanged')
    expect(readFileSync(p.bridgeKey, 'utf8')).toBe(before)
  })

  test('on 4401 with the current key the bridge retries with bridge.key.prev and logs rotation_incomplete', async () => {
    h = await startHarness({ startBridge: false })
    const p = paths(h.home)
    const good = readFileSync(p.bridgeKey, 'utf8')
    writeFileSync(p.bridgeKeyPrev, good, { mode: 0o600 })
    const { newStoredKey } = await import('../src/keys.ts')
    writeFileSync(p.bridgeKey, JSON.stringify(await newStoredKey()), { mode: 0o600 }) // a key the relay does not know
    const lines: string[] = []
    const { createLogger } = await import('../src/log.ts')
    const b: BridgeT = await Bridge.create({
      env: h.bridge.ctx.env,
      logger: createLogger(null, 'debug', (l) => lines.push(l)),
      random: () => 0,
      inbound: { settleMs: 10 },
    })
    b.setEmit(async () => {})
    b.start()
    await waitFor(() => h.relay.bridgeConnected, 5000, 'connect with the previous key')
    // the relay flips first; the bridge logs the fallback when it reads `ready`
    await waitFor(() => lines.join('').includes('rotation_incomplete'), 5000, 'the rotation_incomplete log line')
    expect(lines.join('')).toContain('rotation_incomplete')
    await b.stop()
  })
})
