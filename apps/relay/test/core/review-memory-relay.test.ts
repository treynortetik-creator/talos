/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Adversarial review of WP-V5 (PR #44) at the REAL relay hub: memory answers reach only the socket that asked, a frame
// posing as an answer from an app socket goes nowhere, an answer nobody asked for goes nowhere, and nothing memory-shaped
// is ever stored or replayed in catch-up. These are guards (they hold on the PR head); they pin the routing the memory
// browser relies on so a later relay change cannot quietly fan a note out.
import { newUlid } from '@talos-app/protocol'
import { mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const fileFrame = (request_id: string, text: string) => ({
  ...mkFrame('memory.file'),
  request_id,
  root_id: 'notes',
  path: 'a.md',
  mime: 'text/markdown',
  text,
  offset: 0,
  next_offset: null,
  size: Buffer.byteLength(text),
  mtime: '2026-10-20T12:00:00.000Z',
  sha256: 'a'.repeat(64),
  links: [],
})

describe('memory routing at the real relay (guards)', () => {
  it('spoofed and unsolicited memory answers reach nobody, and nothing is stored', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['memory/1'],
      })
      .connect()
    const store = relay.runtime.store
    const seq0 = store.maxSeq()

    // 1. the asker's request reaches the bridge; the OTHER socket injects an answer with the asker's request_id
    const rid = newUlid()
    const ask = await app.sign({
      ...mkFrame('memory.read'),
      request_id: rid,
      root_id: 'notes',
      path: 'a.md',
      offset: 0,
    })
    app.send(ask)
    await bridge.expectFrame('memory.read' as never, ((x: { id: string }) => x.id === ask.id) as never, {
      direction: 'in',
    })
    other.send(fileFrame(rid, 'SPOOFED by another socket') as never)
    await sleep(300)
    expect(app.rec.frames.some((r) => r.direction === 'in' && JSON.stringify(r.raw).includes('SPOOFED'))).toBe(false)

    // 2. the real answer goes to the asker only
    bridge.send(fileFrame(rid, 'the real note') as never)
    await app.expectFrame('memory.file' as never, ((x: any) => x.request_id === rid) as never, { direction: 'in' })
    // a second answer under the same request_id (a replay by the bridge side) is not delivered twice
    bridge.send(fileFrame(rid, 'REPLAYED answer') as never)

    // 3. an answer for a request nobody made reaches nobody
    bridge.send(fileFrame(newUlid(), 'UNSOLICITED note') as never)
    await sleep(300)
    for (const s of [app, other])
      for (const word of ['UNSOLICITED', 'REPLAYED'])
        expect(s.rec.frames.some((r) => r.direction === 'in' && JSON.stringify(r.raw).includes(word))).toBe(false)
    expect(other.rec.frames.some((r) => r.direction === 'in' && String(r.raw.type).startsWith('memory.'))).toBe(false)

    // 4. nothing memory-shaped in the relay's event log, so catch-up can never replay a note
    expect(store.maxSeq()).toBe(seq0)
    const late = await k.connectedApp({ lastSeq: 0 })
    await sleep(300)
    expect(late.rec.frames.some((r) => JSON.stringify(r.raw).includes('the real note'))).toBe(false)

    await app.close()
    await other.close()
    await late.close()
    await bridge.close()
  })
})
