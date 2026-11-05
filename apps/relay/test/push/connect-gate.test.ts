// The last look before a native push leaves must come AFTER the connection to Apple is up. A request queued behind a
// handshake leaves whenever the handshake ends, so a revoke that lands during the connect wait must still be honoured.
// Real sender, real HTTP/2 fake APNs. The only fake is the connect delay: node:http2's connect() is given a socket whose
// address lookup waits for the test, which is exactly how a slow TCP/TLS setup looks to the session (`connecting`).
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })

const hold = vi.hoisted(() => ({
  on: false,
  waiting: [] as Array<() => void>,
  connects: 0,
}))
vi.mock('node:http2', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:http2')>()
  const net = await import('node:net')
  const patched = {
    ...real,
    connect: (authority: string | URL, ...rest: unknown[]) => {
      hold.connects++
      if (!hold.on) return (real.connect as (...a: unknown[]) => unknown)(authority, ...rest)
      const u = new URL(String(authority))
      return real.connect(authority, {
        createConnection: () =>
          net.connect({
            host: 'slow.test',
            port: Number(u.port),
            lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
              hold.waiting.push(() =>
                o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
              )
            }) as never,
          }),
      })
    },
  }
  return { ...patched, default: patched }
})
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
const payload = {
  web_push: 8030,
  notification: { title: 'Talos', body: 'New reply in a thread', navigate: '/', silent: false },
  talos: { v: 1, kind: 'reply' },
} as const
const dev = { token: 'a'.repeat(64), env: 'sandbox' } as const
const cleanups: Array<() => unknown> = []
const releaseAll = () => {
  for (const r of hold.waiting.splice(0)) r()
}
afterEach(async () => {
  hold.on = false
  releaseAll()
  hold.connects = 0
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function setup(timeoutMs?: number) {
  const fake = await startFakeApns(key.publicKey)
  cleanups.push(() => fake.close())
  const sender = createApnsSender({
    config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
    clock: fakeClock(),
    log: silent,
    authority: () => fake.url,
    ...(timeoutMs ? { timeoutMs } : {}),
  }) as ApnsSender
  cleanups.push(() => sender.close())
  return { fake, sender }
}
const flush = () => new Promise((r) => setTimeout(r, 25))

describe('the send gate runs after the connection is up', () => {
  it('a revoke during the connect wait of a new connection sends nothing', async () => {
    const { fake, sender } = await setup()
    hold.on = true
    let trusted = true
    const gateSawWaiting: number[] = []
    const p = sender.send(dev, payload, {
      gate: () => {
        gateSawWaiting.push(hold.waiting.length)
        return trusted ? 'seal' : 'none'
      },
    })
    await vi.waitFor(() => expect(hold.waiting.length).toBe(1)) // the connection is still being set up
    await flush()
    expect(gateSawWaiting).toEqual([]) // the gate has not looked yet
    trusted = false // the revoke lands during the connect wait
    releaseAll()
    const r = await p
    expect(r.skipped).toBe(true)
    expect(r.ok).toBe(false)
    expect(gateSawWaiting).toHaveLength(1)
    expect(fake.requests).toHaveLength(0)
  })

  it('control: no revoke, the same held connection, the push goes out', async () => {
    const { fake, sender } = await setup()
    hold.on = true
    const p = sender.send(dev, payload, { gate: () => 'seal' })
    await vi.waitFor(() => expect(hold.waiting.length).toBe(1))
    releaseAll()
    expect((await p).ok).toBe(true)
    expect(fake.requests).toHaveLength(1)
  })

  it('a send that joins a connection still being set up also waits, and a revoke stops both', async () => {
    const { fake, sender } = await setup()
    hold.on = true
    let trusted = true
    const looks: string[] = []
    const gate = (name: string) => () => {
      looks.push(name)
      return trusted ? ('seal' as const) : ('none' as const)
    }
    const a = sender.send(dev, payload, { gate: gate('a') })
    await vi.waitFor(() => expect(hold.waiting.length).toBe(1))
    const b = sender.send({ ...dev, token: 'b'.repeat(64) }, payload, { gate: gate('b') })
    await flush()
    expect(hold.connects).toBe(1) // b joined a's connection
    expect(looks).toEqual([])
    trusted = false
    releaseAll()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.skipped).toBe(true)
    expect(rb.skipped).toBe(true)
    expect(looks.sort()).toEqual(['a', 'b'])
    expect(fake.requests).toHaveLength(0)
  })

  it('a connection that never comes up fails as a ConnectionError within the timeout and the gate never runs', async () => {
    const { fake, sender } = await setup(150)
    hold.on = true
    let looked = false
    const r = await sender.send(dev, payload, {
      gate: () => {
        looked = true
        return 'seal'
      },
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('ConnectionError')
    expect(looked).toBe(false)
    expect(fake.requests).toHaveLength(0)
    // and the stuck connection is not kept: the next send opens a new one and works
    hold.on = false
    expect((await sender.send(dev, payload, { gate: () => 'seal' })).ok).toBe(true)
  })
})
