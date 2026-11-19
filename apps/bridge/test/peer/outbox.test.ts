// The sender loop: a durable outbox, the same id on every try, a fresh timestamp each time, and what each answer means.
import { afterEach, describe, expect, test } from 'bun:test'
import { PEER_RETRY_HOURS } from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { createLogger } from '../../src/log.ts'
import { PeerService } from '../../src/peer/service.ts'
import { type Install, install, linkBoth, memorySecrets, rowsOf, text } from './helpers.ts'

let a: Install | undefined
let b: Install | undefined
let extra: Bridge | undefined
afterEach(async () => {
  await extra?.stop()
  await a?.stop()
  await b?.stop()
  a = b = extra = undefined
})

async function pair() {
  a = await install({ to: () => b })
  b = await install({ to: () => a })
  await linkBoth(a, b)
  return { a, b }
}
const send = (h: Install, args: Record<string, unknown> = {}) =>
  h.bridge.callTool('peer_send', { peer: 'work', text: 'a message', label: 'TASK', ...args })

describe('the sender loop', () => {
  test('a 5xx is retried with the same id and a fresh timestamp, and then lands once', async () => {
    const { a, b } = await pair()
    b.relay.peers.refuse = { status: 503, error: 'unavailable' }
    await send(a)
    await waitFor(() => a.calls.length === 1, 4000, 'first try')
    expect(a.calls[0]?.status).toBe(503)
    b.relay.peers.refuse = null
    a.clock.advance(20_000)
    await waitFor(() => a.calls.length === 2, 4000, 'second try')
    expect(a.calls[1]?.id).toBe(a.calls[0]?.id)
    expect(a.calls[1]?.status).toBe(200)
    expect(Number(a.calls[1]?.ts)).toBeGreaterThan(Number(a.calls[0]?.ts))
    await waitFor(() => b.peerNotes().length === 1, 4000, 'landed')
  })

  test('another 4xx stops with a row naming the code, and is not retried', async () => {
    const { a, b } = await pair()
    b.relay.peers.refuse = { status: 400, error: 'bad_body' }
    await send(a)
    await waitFor(() => rowsOf(a).some((t) => t.includes('refused a message (bad_body)')), 4000, 'the row')
    a.clock.advance(3 * 3600_000)
    await new Promise((r) => setTimeout(r, 200))
    expect(a.calls).toHaveLength(1)
  })

  test('after the retry window it gives up with a row', async () => {
    const { a, b } = await pair()
    b.relay.peers.refuse = { status: 503, error: 'unavailable' }
    await send(a)
    await waitFor(() => a.calls.length === 1, 4000, 'first')
    let n = 1
    for (let i = 0; i < 60 && !rowsOf(a).some((t) => t.includes('Gave up sending')); i++) {
      a.clock.advance(31 * 60_000)
      await waitFor(() => a.calls.length > n || rowsOf(a).some((t) => t.includes('Gave up')), 4000, 'a try').catch(
        () => {},
      )
      n = a.calls.length
    }
    expect(rowsOf(a).some((t) => t.includes(`Gave up sending a message to work after ${PEER_RETRY_HOURS} hours`))).toBe(
      true,
    )
    const before = a.calls.length
    a.clock.advance(5 * 3600_000)
    await new Promise((r) => setTimeout(r, 200))
    expect(a.calls).toHaveLength(before)
  })

  test('the outbox survives a restart, and the retry keeps the same id', async () => {
    const { a, b } = await pair()
    b.relay.peers.refuse = { status: 503, error: 'unavailable' }
    await send(a)
    await waitFor(() => a.calls.length === 1, 4000, 'first')
    const id = a.calls[0]?.id
    await a.bridge.stop() // the Mac restarts
    b.relay.peers.refuse = null
    const calls: Array<{ id: string }> = []
    extra = await Bridge.create({
      env: loadEnv({ TALOS_APP_HOME: a.home, TALOS_APP_RELAY_URL: a.relay.httpUrl, TALOS_APP_BRIDGE: '1' }),
      logger: createLogger(null, 'error', () => {}),
      peers: {
        secrets: a.secrets,
        clock: a.clock,
        fetch: async (url, init) => {
          calls.push({ id: String((init.headers as Record<string, string>)['webhook-id']) })
          return fetch(`${b?.relay.httpUrl}${new URL(url).pathname}`, init as RequestInit)
        },
      },
    })
    extra.start()
    a.clock.advance(60_000)
    await waitFor(() => calls.length === 1, 4000, 'the retry after the restart')
    expect(calls[0]?.id).toBe(id as string)
    await waitFor(() => (b as Install).peerNotes().length === 1, 4000, 'landed')
  })

  test('an address Talos will not contact is refused at once, not retried', async () => {
    a = await install()
    b = await install()
    await linkBoth(a, b)
    a.bridge.ctx.config.update((c) => ({
      ...c,
      peers: [{ name: 'work', url: 'https://127.0.0.1:9/hook/peer/cn_x', daily_cap: 50 }],
    }))
    const svc = new PeerService(a.bridge.ctx, { secrets: a.secrets, clock: a.clock }) // the real guarded fetch
    const r = await svc.send({ peer: 'work', text: 'hello' })
    expect(r.ok).toBe(true)
    await waitFor(() => rowsOf(a as Install).some((t) => t.includes('one Talos will not contact')), 4000, 'the row')
    svc.stop()
  })

  test('log lines never carry the text or the secret', async () => {
    const lines: string[] = []
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    const ctx = a.bridge.ctx
    for (const level of ['info', 'warn', 'error'] as const) {
      const orig = ctx.log[level].bind(ctx.log)
      ctx.log[level] = ((m: string, f?: Record<string, unknown>) => {
        lines.push(`${m} ${JSON.stringify(f ?? {})}`)
        return orig(m, f)
      }) as never
    }
    b.relay.peers.refuse = { status: 503, error: 'unavailable' }
    const secretText = 'the plan involves the blue folder and the tall ladder'
    await send(a, { text: secretText })
    await waitFor(() => a?.calls.length === 1, 4000, 'try')
    const secret = [...a.secrets.data.values()][0] as string
    for (const l of lines) {
      expect(l).not.toContain(secretText)
      expect(l).not.toContain(secret)
    }
    void fakeClock
    void memorySecrets
    void text
  })
})
