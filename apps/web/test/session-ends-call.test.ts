// @vitest-environment jsdom
// Signing out or being revoked must hang up a live voice call: the microphone and the relay session close with it.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearLocalData } from '../src/features/auth/session.ts'
import { CallController } from '../src/features/voice/callController.ts'
import { setCallController } from '../src/features/voice/controller.ts'
import { createFakeClient } from '../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { fakeDeps } from './voice/fakes.ts'

const tick = () => new Promise((r) => setTimeout(r, 10))
beforeEach(() => localStorage.clear())

describe('the sign-out reset', () => {
  it('ends a live call: mic track stopped, peer closed, phase idle', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    setCallController(c)
    const started = c.start(createFakeClient(), 'general')
    await tick()
    f.peer.dc.emit({ type: 'session.started' })
    await started
    expect(c.store.getState().phase).toBe('live')
    await clearLocalData(createMemoryStorage())
    await tick()
    expect(f.track.stopped).toBe(true)
    expect(f.peer.closed).toBe(true)
    expect(c.store.getState().phase).toBe('idle')
    setCallController(null)
  })

  it('is safe when no call is active', async () => {
    const c = new CallController(fakeDeps().deps)
    setCallController(c)
    await expect(clearLocalData(createMemoryStorage())).resolves.toBeUndefined()
    expect(c.store.getState().phase).toBe('idle')
    setCallController(null)
  })
})
