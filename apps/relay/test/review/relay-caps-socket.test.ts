// A pool slot must come back when the body deadline fires or the client goes away, on REAL sockets. The in-process
// tests in relay-caps-followups.test.ts release the stalled body by hand, which hid a leak: the deadline answered 408 but
// the handler stayed parked in its body read, so its slot was never given back.
import { connect, type Socket } from 'node:net'
import { signBridgeHttp } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { frameGate, UNVERIFIED_FRAMES_PER_IP } from '../../src/core/upload-gate.ts'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 60_000 })

let r: RealRelay | null = null
const sockets: Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await r?.stop()
  r = null
  resetAuthImplementation()
})

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** Opens a POST /bridge/post that declares 200 KB (over the small-body bypass), sends 1 KB, then stalls. */
async function stalledPost(relay: RealRelay): Promise<{ socket: Socket; head: Promise<string> }> {
  const auth = await signBridgeHttp({
    privateKey: relay.bridgeKey.privateKey,
    keyId: relay.bridgeKey.keyId,
    method: 'POST',
    pathWithQuery: '/bridge/post',
    body: '',
  })
  const port = relay.relay.port
  const socket = connect(port, '127.0.0.1')
  sockets.push(socket)
  socket.on('error', () => undefined)
  let buf = ''
  const head = new Promise<string>((res) => {
    socket.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n')) res(buf.split('\r\n')[0] ?? '')
    })
    socket.on('close', () => res(buf.split('\r\n')[0] ?? ''))
  })
  socket.write(
    `POST /bridge/post HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: 200000\r\n\r\n`,
  )
  socket.write(Buffer.alloc(1024, 0x20))
  return { socket, head }
}

describe('a pool slot comes back when the read ends without the body finishing', () => {
  it('the client hangs up mid-body: the slot is returned', async () => {
    r = await startRealRelay()
    const gate = frameGate(r.relay.services)
    const held = await Promise.all([stalledPost(r), stalledPost(r), stalledPost(r)])
    await pause(300)
    expect(gate.inFlight).toBe(3)
    for (const h of held) h.socket.destroy()
    await pause(500)
    expect(gate.inFlight).toBe(0)
  })

  it('the 15 s deadline answers 408 and the slot is returned (pool full, then free again)', async () => {
    r = await startRealRelay()
    const gate = frameGate(r.relay.services)
    const held = await Promise.all(Array.from({ length: UNVERIFIED_FRAMES_PER_IP }, () => stalledPost(r as RealRelay)))
    await pause(300)
    expect(gate.inFlight).toBe(UNVERIFIED_FRAMES_PER_IP)
    // this address is full: the next one is refused straight away
    const over = await stalledPost(r)
    expect(await over.head).toContain('429')
    for (const h of held) expect(await h.head).toContain('408')
    await pause(300) // the client sockets stay open on purpose: the slot must not depend on them closing
    expect(gate.inFlight).toBe(0)
    const again = await stalledPost(r)
    await pause(300)
    expect(gate.inFlight).toBe(1) // accepted, not 429
    again.socket.destroy()
  })
})
