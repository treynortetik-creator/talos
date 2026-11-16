// The service worker's pass-through (src/sw.ts): a relay page is never answered with the app's shell.
import { describe, expect, it } from 'vitest'
import { goesToRelay } from '../src/features/pwa/relayPaths.ts'

describe('which navigations reach the relay', () => {
  it('an org page’s link and its frame do (else the frame shows the app shell, not the page)', () => {
    expect(goesToRelay('/p/pg_01JBF3V7Q8K2M4N6P8R0S2T4V9')).toBe(true)
    expect(goesToRelay('/p/pg_01JBF3V7Q8K2M4N6P8R0S2T4V9/frame')).toBe(true)
  })
  it('so do the relay’s own spaces, as before', () => {
    for (const p of ['/api/pages', '/media/md_x/page', '/hook/x', '/bridge/x', '/ws', '/healthz'])
      expect(goesToRelay(p), p).toBe(true)
  })
  it('app routes that only start with the same letters stay the app’s', () => {
    for (const p of ['/', '/pages', '/pairing', '/threads/trip', '/apis', '/settings'])
      expect(goesToRelay(p), p).toBe(false)
  })
})
