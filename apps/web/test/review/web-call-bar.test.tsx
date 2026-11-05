// Review finding #5: the live-call bar must mount during a real call. Nothing in the repo emits an `on_call` thread
// status, so the thread screen has to follow the call controller's own phase.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { CallController } from '../../src/features/voice/callController.ts'
import { setCallController } from '../../src/features/voice/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { fakeDeps } from '../voice/fakes.ts'

afterEach(() => {
  cleanup()
  setCallController(null)
})

describe('thread screen during a call', () => {
  it('shows the call controls (End, Mute) while the call controller is running, with no on_call status', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    setCallController(c)
    const client = createFakeClient()
    const started = c.start(client, 'general')
    await new Promise((r) => setTimeout(r, 10))
    f.peer.dc.emit({ type: 'session.started' })
    await started
    expect(client.store.getState().statuses.general?.state).not.toBe('on_call')
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/t/general']}>
          <Routes>
            <Route path="/t/:thread" element={<ThreadScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(await screen.findByRole('toolbar', { name: 'Call controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /end/i })).toBeTruthy()
    await c.end()
  })
})
