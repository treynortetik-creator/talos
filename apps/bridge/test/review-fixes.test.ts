// Regression tests for the full-codebase review (bridge findings). Each block names the finding it pins.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { DeviceStore } from '../src/devices.ts'
import { writeFileAtomic } from '../src/fsutil.ts'
import { nullLogger } from '../src/log.ts'
import { installMcp, mcpEntry } from '../src/mcp-config.ts'
import { eventually, type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

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

const helloKeyIds = (hh: Harness) =>
  hh.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'hello')
    .map((r) => (r.frame as { key_id: string }).key_id)

describe('#6 rotate reconnect', () => {
  test('talos-app rotate opens exactly one new socket and the bridge stays live past the first backoff', async () => {
    h = await startHarness({ relay: { bridgeAuth: 'off' }, bridge: { random: () => 0 } })
    const { err, io } = cliIO()
    expect(await runCli(['rotate'], io, { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl })).toBe(0)
    expect(err).toEqual([])
    const newKey = JSON.parse(readFileSync(paths(h.home).bridgeKey, 'utf8')).key_id as string
    await h.bridge.poll()
    await waitFor(() => helloKeyIds(h).includes(newKey), 4000, 'hello with the new key')
    await sleep(1600) // longer than the first reconnect backoff (800 ms with random=0): a stray timer would fire by now
    expect(helloKeyIds(h).filter((k) => k === newKey)).toHaveLength(1)
    expect(h.bridge.live).toBe(true)
    expect(h.relay.bridgeConnected).toBe(true)
    expect(h.notes.filter((n) => n.meta.kind === 'system')).toEqual([]) // no "Another bridge connected" notice
  })

  test('a stale ready after the bridge went headless is a no-op, not an unhandled rejection', async () => {
    h = await startHarness()
    h.relay.kickBridge(4409)
    await waitFor(() => !h.bridge.live, 4000, 'headless after 4409')
    const onReady = (h.bridge as unknown as { onReady(): void }).onReady.bind(h.bridge)
    expect(() => onReady()).not.toThrow()
  })
})

describe('#7 oversized durable frames', () => {
  const bigCard = {
    thread_id: 'general',
    kind: 'generic',
    title: 'Big',
    primary_label: 'Go',
    kill_label: 'Kill big',
    risk: 'low',
    origin: 'chat',
    body: 'x'.repeat(20_000),
    payload: 'y'.repeat(40_000),
    fields: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, value: 'z'.repeat(20_000) })),
  }

  test('the card tool refuses a schema-valid card over the relay frame limit; nothing is queued, the socket survives', async () => {
    h = await startHarness()
    const before = h.relay.frames.filter((r) => r.direction === 'to_bridge' && r.frame.type === 'ready').length
    const res = await h.bridge.callTool('card', bigCard)
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/too large/i)
    expect(h.bridge.ctx.store.outboxCount()).toBe(0)
    expect(h.bridge.ctx.ledger.list('pending')).toHaveLength(0)
    await sleep(300)
    await eventually(() => expect(h.relay.bridgeConnected).toBe(true))
    expect(h.relay.frames.filter((r) => r.direction === 'to_bridge' && r.frame.type === 'ready').length).toBe(before)
  })

  test('an oversized row already in the outbox is dropped on ready instead of wedging the Mac offline', async () => {
    h = await startHarness({ startBridge: false, bridge: { random: () => 0 } })
    const frame = {
      v: 1,
      type: 'reply',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: new Date().toISOString(),
      message: { text: 'x'.repeat(300_000) },
    }
    h.bridge.ctx.store.outboxAdd(frame.id, 'reply', JSON.stringify(frame), Date.now())
    h.bridge.start()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    await waitFor(() => h.bridge.ctx.store.outboxCount() === 0, 4000, 'oversized outbox row dropped')
    await sleep(1500) // a close-and-resend loop would have reconnected by now
    expect(h.relay.frames.filter((r) => r.direction === 'to_bridge' && r.frame.type === 'ready')).toHaveLength(1)
    expect(h.relay.bridgeConnected).toBe(true)
  })

  test('an outbox row the relay never acks is kept across any number of reconnects', async () => {
    h = await startHarness()
    const frame = { v: 1, type: 'receipt', id: '01JBF3V7Q8K2M4N6P8R0S2T4V7', ts: new Date().toISOString() }
    h.bridge.ctx.store.outboxAdd(frame.id, 'receipt', JSON.stringify(frame), Date.now())
    const t = h.bridge.ctx.transport as unknown as { flushOutbox(): void }
    for (let i = 0; i < 50; i++) t.flushOutbox()
    expect(h.bridge.ctx.store.outboxGet(frame.id)).toBeDefined()
  })

  test('an outbox row older than the retention window is dropped and the agent is told', async () => {
    h = await startHarness()
    const frame = { v: 1, type: 'receipt', id: '01JBF3V7Q8K2M4N6P8R0S2T4V8', ts: new Date().toISOString() }
    h.bridge.ctx.store.outboxAdd(frame.id, 'receipt', JSON.stringify(frame), Date.now() - 25 * 3_600_000)
    const before = h.notes.length
    ;(h.bridge.ctx.transport as unknown as { flushOutbox(): void }).flushOutbox()
    // the row itself, not the total: a config.sync still in flight would count too
    expect(h.bridge.ctx.store.outboxGet(frame.id)).toBeUndefined()
    await waitFor(() => h.notes.length > before, 2000, 'agent told about the drop')
    expect(JSON.stringify(h.notes.slice(before))).toContain('never reached the relay')
  })

  test('history.page is cut by bytes: 100 big messages come back as a page that fits, with has_more', async () => {
    h = await startHarness()
    const store = h.bridge.ctx.store
    for (let i = 0; i < 100; i++) {
      store.addMessage({
        id: `m_${String(i).padStart(26, '0')}`,
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text: 'h'.repeat(30_000),
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      } as never)
    }
    await h.app.sendHistoryRequest('general', { request_id: 'rbig', limit: 100 })
    const page = await h.relay.expectFrame('history.page', (f) => f.request_id === 'rbig', { direction: 'from_bridge' })
    const rec = h.relay.frames.find((r) => r.direction === 'from_bridge' && r.frame.type === 'history.page')
    expect(Buffer.byteLength(JSON.stringify(rec?.raw))).toBeLessThan(262_144)
    expect(page.has_more).toBe(true)
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.messages.length).toBeLessThan(100)
    expect(page.messages.at(-1)?.id).toBe(`m_${'99'.padStart(26, '0')}`) // newest end of the window is kept
    await sleep(200)
    await eventually(() => expect(h.relay.bridgeConnected).toBe(true))
  })
})

describe('#15 relay error{ref} for a durable bridge frame', () => {
  test('a card the relay refuses fails the tool at once, leaves nothing in the outbox and is never resent', async () => {
    // A fake clock that is never advanced: the 8 s wait for an ack can not run out, so the tool can only fail because the
    // relay's error{ref} reached it.
    const clock = fakeClock()
    h = await startHarness({
      clock,
      relay: {
        rejectBridgeFrame: (f) =>
          f.type === 'card.create' ? { code: 'bad_frame', message: 'card refused for the test' } : undefined,
      },
    })
    const res = await h.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'generic',
      title: 'Refused',
      primary_label: 'Go',
      kill_label: 'Kill it',
      risk: 'low',
      origin: 'chat',
    })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('bad_frame')
    expect(h.bridge.ctx.store.outboxCount()).toBe(0)
    expect(h.bridge.ctx.ledger.list('pending')).toHaveLength(0)
    expect(h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'card.create')).toHaveLength(
      1,
    )
  })
})

describe('#14 reconnect while inbound frames are being collected', () => {
  test('a message collected before the socket dropped is delivered after the reconnect, not lost', async () => {
    h = await startHarness({
      bridge: { random: () => 0, inbound: { settleMs: 6000, maxSettleMs: 12_000 } },
    })
    const sent = await h.app.sendMessage('general', 'collected then dropped')
    await h.relay.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'delivered', { direction: 'from_bridge' })
    expect(h.notes).toHaveLength(0) // still inside the settle window
    const mark = h.relay.frames.length
    h.relay.dropBridge()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge', since: mark })
    await waitFor(() => h.notes.some((n) => n.content.includes('collected then dropped')), 5000, 'the message')
  })
})

describe('#17 writing into the agent folder', () => {
  test("installing .mcp.json leaves the mode of the user's agent folder alone", () => {
    const agent = join(tempHome('talos-agent-'), 'agent')
    mkdirSync(agent, { mode: 0o755 })
    chmodSync(agent, 0o755)
    const r = installMcp(agent, mcpEntry('/opt/talos/bridge', '/tmp/home'), false)
    expect(r.changed).toBe(true)
    expect(statSync(agent).mode & 0o777).toBe(0o755)
    expect(statSync(join(agent, '.mcp.json')).mode & 0o777).toBe(0o644)
  })

  test('writeFileAtomic still creates a missing parent as 0700', () => {
    const dir = join(tempHome('talos-agent-'), 'fresh', 'sub')
    writeFileAtomic(join(dir, 'f.json'), '{}')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('#18 unhandled rejections', () => {
  test('a floating rejection is logged and the process lives on (Bun exits on any unhandled rejection otherwise)', async () => {
    const run = (guard: boolean) =>
      Bun.spawn(['bun', 'run', join(import.meta.dir, 'fixtures', guard ? 'reject-after-guard.ts' : 'reject-bare.ts')], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    const p = run(true)
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    expect(code).toBe(0)
    expect(err).toContain('STILL_ALIVE')
    expect(err).toContain('unhandled rejection')
    expect(err).toContain('floating boom')
    const bare = run(false) // control: without the guard Bun does die, so the test above really exercises the guard
    const [, bareCode] = await Promise.all([new Response(bare.stderr).text(), bare.exited])
    expect(bareCode).not.toBe(0)
  })

  test('a failing emit during card expiry does not leave a floating rejection', async () => {
    const seen: unknown[] = []
    const onRej = (r: unknown) => seen.push(r)
    process.on('unhandledRejection', onRej)
    try {
      h = await startHarness()
      h.bridge.setEmit(async () => {
        throw new Error('channel closed')
      })
      const res = await h.bridge.callTool('card', {
        thread_id: 'general',
        kind: 'generic',
        title: 'Soon gone',
        primary_label: 'Go',
        kill_label: 'Kill it',
        risk: 'low',
        origin: 'chat',
        expires_in_s: 1,
      })
      expect(res.isError).toBeUndefined()
      await sleep(1500)
      h.bridge.expiry.sync() // also covers the sweep path for cards already past due
      await sleep(200)
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onRej)
    }
  })
})

describe('#38 non-consumable durable frames are acked after processing', () => {
  test('a device.revoked whose processing failed stays in the relay buffer and is applied on the replay', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    const victim = 'd_rjxnk4xufxem5xago5zd'
    const devices = h.bridge.ctx.devices
    const realRevoke = devices.revoke.bind(devices)
    devices.revoke = () => {
      throw new Error('disk full')
    }
    const f = h.relay.sendToBridge({ type: 'device.revoked', device_id: victim })
    await sleep(400)
    await eventually(() => expect(h.relay.buffered((e) => e.frame.id === f.id)).toHaveLength(1)) // never acked: the relay still holds it
    expect(devices.isRevoked(victim)).toBe(false)
    devices.revoke = realRevoke
    const mark = h.relay.frames.length
    h.relay.dropBridge()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge', since: mark })
    await waitFor(() => devices.isRevoked(victim), 4000, 'the replayed revoke applied')
    await waitFor(() => h.relay.buffered((e) => e.frame.id === f.id).length === 0, 4000, 'acked after processing')
  })

  test('a config.patch is acked only once it has been applied: a failed apply stays unacked and is applied on the replay', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    const cfg = h.bridge.ctx.config
    const realApply = cfg.applyPatch.bind(cfg)
    let failures = 1
    cfg.applyPatch = (...args: Parameters<typeof realApply>) => {
      if (failures-- > 0) throw new Error('disk full')
      return realApply(...args)
    }
    const ackOf = (id: string) =>
      h.relay.frames.filter(
        (r) => r.direction === 'from_bridge' && r.frame.type === 'ack' && (r.frame as { ref: string }).ref === id,
      )
    const f = await h.app.sendConfigPatch(cfg.config.rev, { timezone: 'Etc/GMT+7' })
    // The bridge handles frames one at a time, so once a later frame is acked the patch's outcome is already decided.
    const marker = h.relay.sendToBridge({ type: 'device.revoked', device_id: 'd_rjxnk4xufxem5xago5zd' })
    await eventually(() => expect(ackOf(String(marker.id)).length).toBeGreaterThan(0))
    expect(ackOf(f.id)).toHaveLength(0) // the apply threw: no ack, so the relay still holds the frame
    expect(h.relay.buffered((e) => e.frame.id === f.id)).toHaveLength(1)
    expect(cfg.config.timezone).toBe('UTC')
    const mark = h.relay.frames.length
    h.relay.dropBridge()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge', since: mark })
    await waitFor(() => cfg.config.timezone === 'Etc/GMT+7', 4000, 'the replayed patch applied')
    await waitFor(() => ackOf(f.id).length > 0, 4000, 'acked after it was applied')
  })
})

describe('#39 a corrupt devices.json fails closed', () => {
  const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never
  const revokedFile = JSON.stringify({
    version: 1,
    devices: [{ id: 'd_rjxnk4xufxem5xago5zd', name: 'Lost phone', revoked_at: '2026-10-01T00:00:00.000Z' }],
  })

  test('pin() refuses to overwrite a file it cannot parse, so revoked tombstones survive', () => {
    const path = join(tempHome('talos-dev-'), 'devices.json')
    writeFileSync(path, `${revokedFile.slice(0, 40)}<<<corrupt`)
    const before = readFileSync(path, 'utf8')
    const store = new DeviceStore(path)
    expect(store.isCorrupt()).toBe(true)
    expect(store.pinnedKey('d_rjxnk4xufxem5xago5zd')).toBeUndefined()
    const r = store.pin({ id: 'd_rjxnk4xufxem5xago5zd', name: 'Back again', pubkey_jwk: jwk }, new Date().toISOString())
    expect(r).toEqual({ ok: false, reason: 'corrupt' })
    expect(() => store.revoke('d_other', new Date().toISOString())).toThrow(/unreadable/)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // once the owner repairs the file, the tombstone is back in force and nothing was lost
    writeFileSync(path, revokedFile)
    const fixed = new DeviceStore(path)
    expect(fixed.isCorrupt()).toBe(false)
    expect(fixed.pin({ id: 'd_rjxnk4xufxem5xago5zd', name: 'x', pubkey_jwk: jwk }, 'now')).toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  test('a missing devices.json is a fresh install, not corruption', () => {
    const store = new DeviceStore(join(tempHome('talos-dev-'), 'devices.json'))
    expect(store.isCorrupt()).toBe(false)
    expect(store.pin({ id: 'd_rjxnk4xufxem5xago5zd', name: 'First', pubkey_jwk: jwk }, 'now')).toEqual({ ok: true })
  })

  test('an enrollment confirmed while devices.json is corrupt is not pinned and the file is untouched', async () => {
    h = await startHarness()
    writeFileSync(join(h.home, 'devices.json'), '{ not json')
    const r = h.bridge.ctx.devices.pin({ id: 'd_rjxnk4xufxem5xago5zd', name: 'N', pubkey_jwk: jwk }, 'now')
    expect(r.ok).toBe(false)
    expect(readFileSync(join(h.home, 'devices.json'), 'utf8')).toBe('{ not json')
    // and an owner message from the previously pinned test device is refused, not accepted
    await h.app.sendMessage('general', 'while corrupt')
    const err = await h.relay.expectFrame('error', () => true, { direction: 'from_bridge' })
    expect(err.code).toBe('sig_invalid')
  })
})

describe('#24 relay URL must be https unless loopback', () => {
  test.each([
    'http://relay.example.com',
    'http://localhost.example.com',
    'http://127.0.0.1.example.com',
    'ws://relay.example.com',
    'ftp://x.example.com',
  ])('init refuses %s and writes nothing', async (url) => {
    const home = tempHome()
    const { err, io } = cliIO()
    expect(await runCli(['init', '--relay-url', url], io, { TALOS_APP_HOME: home })).toBe(1)
    expect(err.join('\n')).toMatch(/https/)
    expect(existsSync(join(home, 'bridge.env'))).toBe(false)
  })

  test.each(['https://relay.example.com', 'http://localhost:8080', 'http://127.0.0.1:5000', 'http://[::1]:5000'])(
    'init accepts %s',
    async (url) => {
      const { io } = cliIO()
      expect(await runCli(['init', '--relay-url', url], io, { TALOS_APP_HOME: tempHome() })).toBe(0)
    },
  )

  test('a bridge pointed at a plain-http remote relay will not start, and signed HTTP calls to it are refused', async () => {
    h = await startHarness({ startBridge: false })
    const env = { ...h.bridge.ctx.env, relayUrl: 'http://relay.example.com' }
    const calls: string[] = []
    const bridge = await Bridge.create({
      env,
      logger: nullLogger,
      fetchFn: async (u) => {
        calls.push(u)
        return new Response('{}')
      },
    })
    expect(() => bridge.start()).toThrow(/https/)
    await expect(bridge.ctx.http.post({ type: 'status' } as never)).rejects.toThrow(/https/)
    expect(calls).toEqual([]) // nothing, signed or not, went out over cleartext
    await bridge.stop()
  })
})
