// Where a browser push may be sent. The endpoint comes from a signed-in browser, and the relay then POSTs to it on every
// notification, from inside the relay's own network. So it must be a public https host: when it is stored, and again when
// the connection is made (a name can resolve inward, and a row can predate the check).
import { createECDH, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { buildPushPayload } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import webpush from 'web-push'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { createWebPushTransport, pushEndpointAllowed } from '../../src/core/push.ts'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

let r: RealRelay | null = null
let listener: Server | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  await new Promise<void>((done) => (listener ? listener.close(() => done()) : done()))
  listener = null
})

/** A local TCP listener that only counts who connects: it stands in for a service inside the relay's network. */
async function inwardService(): Promise<{ port: number; connections: () => number }> {
  let n = 0
  const server = createServer((socket) => {
    n++
    socket.destroy()
  })
  listener = server
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const addr = server.address()
  return { port: typeof addr === 'object' && addr ? addr.port : 0, connections: () => n }
}

/** A subscription whose keys really encrypt, so the send gets as far as opening the connection. */
function realSub(endpoint: string) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  }
}

function transport(resolve?: (host: string) => Promise<readonly string[]>) {
  const vapid = webpush.generateVAPIDKeys()
  return createWebPushTransport(
    { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:alex@example.com' },
    resolve ? { resolve } : {},
  )
}

const payload = buildPushPayload({ template: 'reply', thread_id: 'general' }, DEFAULT_AGENT_CONFIG)

describe('a push endpoint must be a public https host', () => {
  const inward = [
    'http://push.example.com/send/1',
    'https://127.0.0.1:8443/send',
    'https://10.0.0.5/send',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]:8443/send',
    'https://[fd12:3456::1]/send',
    'https://[64:ff9b::a9fe:a9fe]/send',
    'https://localhost:8443/send',
    'https://localhost./send',
    'https://redis.railway.internal:6379/',
    'https://printer.local/send',
    'https://intranet/send',
    'https://2130706433/send',
    `https://name:word${'@'}push.example.com/send`,
  ]

  it('says which endpoints it allows', () => {
    for (const e of inward) expect(pushEndpointAllowed(e), e).toBe(false)
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(pushEndpointAllowed('https://web.push.apple.com/abc')).toBe(true)
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
  })

  it('subscribe refuses an inward endpoint and stores nothing', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    for (const endpoint of inward) {
      const res = await r.post('/api/push/subscribe', { endpoint, keys: { p256dh: 'a', auth: 'b' } }, o)
      expect(res.status, endpoint).toBe(400)
    }
    expect(r.runtime.store.listSubs()).toEqual([])
    const ok = await r.post(
      '/api/push/subscribe',
      { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'a', auth: 'b' } },
      o,
    )
    expect(ok.status).toBe(204)
  })
})

describe('sending a browser push', () => {
  it('never connects to an inward address literal, and drops the row', async () => {
    const svc = await inwardService()
    const res = await transport().send(realSub(`https://127.0.0.1:${svc.port}/send`), payload)
    expect(svc.connections()).toBe(0)
    expect(res).toEqual({ ok: false, gone: true })
  })

  it('never connects when a public-looking name resolves inward', async () => {
    const svc = await inwardService()
    const res = await transport(async () => ['127.0.0.1']).send(
      realSub(`https://push.example.com:${svc.port}/send`),
      payload,
    )
    expect(svc.connections()).toBe(0)
    // A name can be pointed somewhere else again: the row stays and the send counts as failed.
    expect(res).toEqual({ ok: false, gone: false })
  })
})
