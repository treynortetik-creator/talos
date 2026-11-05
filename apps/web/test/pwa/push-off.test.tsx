// Audit D51: the web push row can be turned off, and it stays off across opens.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enablePush, isPushOff, resubscribeOnOpen, usePushState } from '../../src/features/pwa/push.ts'
import { NotificationsSection } from '../../src/features/settings/sections.tsx'
import { type Platform, setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const SUB = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } }
const calls: string[] = []
let fetches: Array<{ method: string; url: string; body: unknown }> = []

function platform(): Platform {
  return {
    ...webPlatform,
    push: {
      permission: () => 'granted',
      subscribe: async () => {
        calls.push('subscribe')
        return SUB
      },
      unsubscribe: async () => void calls.push('unsubscribe'),
      resubscribe: async () => {
        calls.push('resubscribe')
        return SUB
      },
    },
  }
}

beforeEach(() => {
  calls.length = 0
  fetches = []
  localStorage.clear()
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'k')
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetches.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(null, { status: 204 })
  })
  setPlatform(platform())
  usePushState.setState({ permission: 'granted', off: false, busy: false, message: null })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setPlatform(webPlatform)
})

describe('web push Turn off', () => {
  it('unsubscribes the browser, deletes the endpoint at the relay, and reads Off', async () => {
    renderWith(<NotificationsSection readOnly={false} />, setup())
    expect(screen.getByTestId('push-status').textContent).toBe('On')
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(screen.getByTestId('push-status').textContent).toBe('Off'))
    expect(calls).toContain('unsubscribe')
    expect(fetches.find((f) => f.method === 'DELETE')).toMatchObject({
      url: '/api/push/subscribe',
      body: { endpoint: SUB.endpoint },
    })
    expect(screen.getByRole('button', { name: 'Turn on notifications' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send a test notification' })).toBeNull()
  })

  it('stays off at the next open: no resubscribe while permission is still granted', async () => {
    renderWith(<NotificationsSection readOnly={false} />, setup())
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(isPushOff()).toBe(true))
    calls.length = 0
    fetches = []
    await resubscribeOnOpen()
    expect(calls).not.toContain('resubscribe')
    expect(fetches.filter((f) => f.method === 'POST')).toEqual([])
    expect(usePushState.getState().off).toBe(true)
  })

  it('a relay that does not confirm is said out loud, and the device still stays off', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }))
    renderWith(<NotificationsSection readOnly={false} />, setup())
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText(/server hasn't confirmed/)).toBeTruthy()
    expect(isPushOff()).toBe(true)
    expect(screen.queryByText(/Try again/)).toBeNull() // no control sits behind it, so it must not promise one
  })

  it('a browser that will not unsubscribe is not reported as off, and Turn off stays on screen', async () => {
    setPlatform({
      ...platform(),
      push: {
        ...platform().push,
        unsubscribe: async () => {
          throw new Error('nope')
        },
      },
    })
    renderWith(<NotificationsSection readOnly={false} />, setup())
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText(/Couldn't turn notifications off/)).toBeTruthy()
    expect(isPushOff()).toBe(false)
    expect(screen.getByTestId('push-status').textContent).toBe('On')
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy() // the retry control is still there
    expect(fetches.filter((f) => f.method === 'DELETE')).toEqual([])
  })

  it('Turn on clears the flag and subscribes again', async () => {
    localStorage.setItem('talos.push.off', '1')
    usePushState.getState().refresh()
    renderWith(<NotificationsSection readOnly={false} />, setup())
    expect(screen.getByTestId('push-status').textContent).toBe('Off')
    await userEvent.click(screen.getByRole('button', { name: 'Turn on notifications' }))
    await waitFor(() => expect(screen.getByTestId('push-status').textContent).toBe('On'))
    expect(isPushOff()).toBe(false)
    expect(fetches.find((f) => f.method === 'POST')).toMatchObject({ url: '/api/push/subscribe', body: SUB })
  })

  it('enablePush that gets no subscription leaves the flag on', async () => {
    localStorage.setItem('talos.push.off', '1')
    setPlatform({ ...platform(), push: { ...platform().push, subscribe: async () => null } })
    await enablePush()
    expect(isPushOff()).toBe(true)
  })
})
