// WP-I5 re-review R5: sends that share a connection, counted by the connections Apple sees.
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })
const key = testKey()
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
} as Logger
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0).reverse()) await c()
})
const reply = {
  web_push: 8030,
  notification: { title: 'Talos', body: 'New reply in a thread', navigate: '/', silent: false },
  talos: { v: 1, kind: 'reply' },
} as const
const dev = { token: 'a'.repeat(64), env: 'sandbox' } as const

async function blackholeProxy(target: string) {
  const t = new URL(target)
  const dead = new WeakSet<Socket>()
  const live = new Set<Socket>()
  const server: Server = createServer((c) => {
    const up = connect(Number(t.port), t.hostname)
    live.add(c)
    c.on('error', () => {})
    up.on('error', () => {})
    c.on('data', (d) => !dead.has(c) && up.write(d))
    up.on('data', (d) => !dead.has(c) && c.write(d))
    c.on('close', () => up.destroy())
    up.on('close', () => c.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    blackhole: () => {
      for (const c of live) dead.add(c)
    },
    close() {
      for (const c of live) c.destroy()
      server.close()
    },
  }
}

describe('R5 one replacement, shared by every send that found the old connection dead', () => {
  it('three concurrent sends on a silently dead idle connection open exactly one new connection', async () => {
    const fake = await startFakeApns(key.publicKey)
    cleanups.push(() => fake.close())
    const p = await blackholeProxy(fake.url)
    cleanups.push(() => p.close())
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: fakeClock(),
      log: silent,
      authority: () => p.url,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    expect((await sender.send(dev, reply)).ok).toBe(true)
    p.blackhole()
    const now = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 31_000)
    const rs = await Promise.all([sender.send(dev, reply), sender.send(dev, reply), sender.send(dev, reply)])
    expect(rs.map((r) => r.ok)).toEqual([true, true, true])
    expect(fake.connections).toBe(2)
  })
})
