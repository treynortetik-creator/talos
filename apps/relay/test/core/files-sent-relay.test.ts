// Files -> Sent through the REAL relay hub: a signed `files.sent` goes to the Mac and its `files.sent_list` comes back to the
// asking socket. The answer had no case in the hub's bridge-frame switch, so it was dropped and the app timed out with "Your
// Mac is offline" (Delphi's simulator, 2026-11-14) while every test passed against the testkit's fake relay. The second test
// keeps the switch and the protocol's list of answers in step, so the next new answer cannot be dropped the same way.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newUlid, V2_READ_RESPONSE_FRAME_TYPES } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('files.sent through the real relay', () => {
  it("reaches the Mac, and the Mac's list reaches the asker", async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const pinned = { [app.device.deviceId]: app.device.publicJwk }
    const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    const ask = await app.sign({
      ...mkFrame('files.sent'),
      request_id: newUlid(),
      filters: { type: 'all', name: '', thread_ids: [], from: 'any', after: null, before: null },
      cursor: null,
      limit: 50,
    })
    app.send(ask)
    await bridge.expectFrame('files.sent', (x) => x.id === ask.id, { direction: 'in' })
    bridge.send({ ...mkFrame('files.sent_list'), request_id: ask.request_id, files: [], next_cursor: null, days: 90 })
    await app.expectFrame('files.sent_list', (x) => x.request_id === ask.request_id, { direction: 'in' })
  })
})

describe('the hub routes every answer the protocol lists (frames.ts V2_READ_RESPONSE_FRAME_TYPES)', () => {
  it('each one is a case that goes to the asking socket', () => {
    const src = readFileSync(join(__dirname, '../../src/core/hub-bridge-frames.ts'), 'utf8')
    // the run of cases that ends in the ephemeral router
    const block = /((?:\s*case '[^']+':)+)\s*return this\.ephemeral\.onResponse\(frame, raw\)/.exec(src)?.[1] ?? ''
    const routed = new Set([...block.matchAll(/case '([^']+)':/g)].map((m) => m[1]))
    for (const t of V2_READ_RESPONSE_FRAME_TYPES)
      expect(routed.has(t), `${t} has no case in hub-bridge-frames.ts`).toBe(true)
  })
})
