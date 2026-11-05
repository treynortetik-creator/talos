// D56: the phone no longer waits forever on "Check your Mac". After CONFIRM_WAIT_MS it says what to check, and it keeps
// listening, so a late "y" on the Mac still finishes setup. The real EnrollPage and parser; only the passkey call and the
// network are stubbed.
import { newEnrollCode } from '@talos-app/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/features/auth/passkeys.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/auth/passkeys.ts')>()),
  runEnrollment: vi.fn(async () => ({ words: ['amber', 'birch', 'cedar', 'dune'], deviceId: 'dev_1' })),
}))

import { CONFIRM_WAIT_MS, EnrollPage } from '../../src/features/auth/EnrollPage.tsx'
import { useSession } from '../../src/features/auth/session.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

type PinnedHandler = (f: { device_id: string; ok: boolean }) => void

function renderPage() {
  const handlers: PinnedHandler[] = []
  const base = createFakeClient()
  const client = {
    ...base,
    ensureDevice: vi.fn(),
    start: vi.fn(async () => {}),
    setPinned: vi.fn(),
    onFrame: (type: string, h: PinnedHandler) => {
      if (type === 'device.pinned') handlers.push(h)
      return () => {
        const i = handlers.indexOf(h)
        if (i >= 0) handlers.splice(i, 1)
      }
    },
  }
  render(
    <ClientProvider client={client as never}>
      <MemoryRouter>
        <EnrollPage />
      </MemoryRouter>
    </ClientProvider>,
  )
  return { handlers, client }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ device_pinned: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
  history.replaceState(null, '', `/enroll#${newEnrollCode()}`)
  vi.spyOn(useSession.getState(), 'refresh').mockResolvedValue(undefined as never)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function toConfirm() {
  const view = renderPage()
  await act(async () => {
    screen.getByRole('button', { name: /^Continue/ }).click()
  })
  expect(screen.getByText('Check your Mac')).toBeTruthy()
  return view
}

describe('enroll waits for the Mac, then says what to do', () => {
  it('shows "Check your Mac" before the limit and the timeout state after it, with the next steps', async () => {
    await toConfirm()
    await act(async () => {
      vi.advanceTimersByTime(CONFIRM_WAIT_MS - 1000)
    })
    expect(screen.queryByText('Your Mac has not answered')).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('heading', { name: 'Your Mac has not answered' })).toBeTruthy()
    expect(screen.getByTestId('fingerprint').textContent).toBe('amber birch cedar dune')
    const text = document.body.textContent ?? ''
    expect(text).toContain('talos-app enroll --confirm')
    // the link was spent when the device registered: the page must not promise it still works
    expect(text).not.toContain('link still works')
    expect(text).toContain('only your Mac saying yes finishes it')
    expect(text).toContain('talos-app start')
    expect(screen.getByRole('button', { name: 'Start over with a new link' })).toBeTruthy()
  })

  it('a late yes from the Mac still finishes setup from the timeout state', async () => {
    const { handlers, client } = await toConfirm()
    await act(async () => {
      vi.advanceTimersByTime(CONFIRM_WAIT_MS + 100)
    })
    expect(screen.getByText('Your Mac has not answered')).toBeTruthy()
    expect(handlers.length).toBeGreaterThan(0)
    await act(async () => {
      for (const h of handlers) h({ device_id: 'dev_1', ok: true })
    })
    expect(screen.getByRole('heading', { name: 'This device is ready' })).toBeTruthy()
    expect(client.setPinned).toHaveBeenCalledWith(true)
  })

  it('a no from the Mac in the timeout state shows the denied screen', async () => {
    const { handlers } = await toConfirm()
    await act(async () => {
      vi.advanceTimersByTime(CONFIRM_WAIT_MS + 100)
    })
    await act(async () => {
      for (const h of handlers) h({ device_id: 'dev_1', ok: false })
    })
    expect(screen.getByRole('heading', { name: 'Your Mac said no to this device' })).toBeTruthy()
  })

  it('a yes inside the limit never shows the timeout', async () => {
    const { handlers } = await toConfirm()
    await act(async () => {
      for (const h of handlers) h({ device_id: 'dev_1', ok: true })
    })
    await act(async () => {
      vi.advanceTimersByTime(CONFIRM_WAIT_MS * 2)
    })
    expect(screen.queryByText('Your Mac has not answered')).toBeNull()
  })
})
