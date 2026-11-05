import { type JwkP256T, parseFrame, verifyOwnerFrame } from '@talos-app/protocol'
import { expect } from 'vitest'
import type { FakeRelay } from '../fake-relay.ts'

/**
 * Web contract: the real web app against FakeRelay sends only valid app->relay frames. Call after driving the app.
 * `pinned` (device id -> public JWK) lets it also verify every owner signature on the RAW JSON the relay received.
 */
export async function assertWebSentOnlyValidFrames(relay: FakeRelay, pinned: Record<string, JwkP256T> = {}) {
  const fromApp = relay.frames.filter((r) => r.direction === 'from_app')
  expect(fromApp.length).toBeGreaterThan(0)
  for (const r of fromApp) {
    const res = parseFrame(r.raw, { direction: 'app_to_relay' })
    expect(res.ok, `${String(r.raw.type)}: ${res.ok ? '' : res.message}`).toBe(true)
    const jwk = typeof r.raw.device_id === 'string' ? pinned[r.raw.device_id] : undefined
    if (jwk && typeof r.raw.osig === 'string') {
      expect(await verifyOwnerFrame(r.raw, jwk), `signature on ${String(r.raw.type)}`).toBe(true)
    }
  }
}
