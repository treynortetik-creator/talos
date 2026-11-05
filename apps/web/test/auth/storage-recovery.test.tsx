// The screens the session gate shows when the device's own storage will not open, hangs, or a wipe cannot finish. The
// owner always has a way out: Try again (which starts again, and on the wipe screen runs the wipe that was owed), and plain
// instructions for clearing this device's data. These screens never delete the device database themselves.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageRecovery, whereAmI } from '../../src/features/auth/StorageRecovery.tsx'

afterEach(cleanup)

describe('StorageRecovery', () => {
  it('while storage has not answered, says so and offers Try again and the instructions at once (no timer decides)', () => {
    render(<StorageRecovery kind="opening" where="browser" onRetry={vi.fn()} />)
    expect(screen.getByText(/still opening/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByText(/clear this site's data/i)).toBeTruthy()
  })

  it('has no button that deletes anything: Try again is the only control', () => {
    for (const kind of ['opening', 'storage', 'wipe'] as const) {
      render(<StorageRecovery kind={kind} where="browser" onRetry={vi.fn()} />)
      expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Try again'])
      cleanup()
    }
  })

  it('in a browser, says what clearing deletes, that it hits every Talos tab, and to close the other tabs first', () => {
    render(<StorageRecovery kind="storage" where="browser" onRetry={vi.fn()} />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/unsent messages/i)
    expect(text).toMatch(/voice notes/i)
    expect(text).toMatch(/chats saved on this device/i)
    expect(text).toMatch(/this device's key/i)
    expect(text).toMatch(/pair this device again/i)
    expect(text).toMatch(/every Talos tab in this browser/i)
    expect(text).toMatch(/close Talos in every other tab/i)
  })

  it('in a browser, the close-other-tabs line comes before the clear step', () => {
    render(<StorageRecovery kind="storage" where="browser" onRetry={vi.fn()} />)
    const text = document.body.textContent ?? ''
    expect(text.indexOf('close Talos in every other tab')).toBeGreaterThan(-1)
    expect(text.indexOf('close Talos in every other tab')).toBeLessThan(text.indexOf("Clear this site's data"))
  })

  it.each([['opening'], ['storage']] as const)(
    'on the %s screen the iPhone and Mac apps are told to restart the app first, with no talk of other tabs',
    (kind) => {
      for (const where of ['iphone', 'mac'] as const) {
        render(<StorageRecovery kind={kind} where={where} onRetry={vi.fn()} />)
        const main = screen.getByRole(kind === 'opening' ? 'status' : 'alert').textContent ?? ''
        expect(main).toMatch(/restart the app/i)
        expect(main).not.toMatch(/tabs/i)
        cleanup()
      }
    },
  )

  it('in a browser the stuck screens still point at other Talos tabs', () => {
    render(<StorageRecovery kind="opening" where="browser" onRetry={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toMatch(/close other Talos tabs/i)
  })

  it('in the iPhone app, says to delete the app and install it again, with no browser steps', () => {
    render(<StorageRecovery kind="storage" where="iphone" onRetry={vi.fn()} />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/delete the talos app/i)
    expect(text).toMatch(/install it again/i)
    expect(text).not.toMatch(/browser/i)
    expect(text).not.toMatch(/other tab/i)
    expect(text).toMatch(/unsent messages, voice notes, chats saved on this device and this device's key/i)
    expect(text).toMatch(/pair this device again/i)
  })

  it('in the Mac app, points at Forget this Mac', () => {
    render(<StorageRecovery kind="storage" where="mac" onRetry={vi.fn()} />)
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/Forget this Mac/)
    expect(text).toMatch(/revokes this Mac/i)
    expect(text).toMatch(/new setup code/i)
    expect(text).toMatch(/unsent messages, voice notes, chats saved on this device and this device's key/i)
    expect(text).not.toMatch(/browser/i)
  })

  it('whereAmI tells the iPhone app, the Mac app and a browser apart', () => {
    const iphone = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }
    const android = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }
    const mac: Record<string, unknown> = {
      webkit: { messageHandlers: { talos: { postMessage() {} } } },
      navigator: { userAgent: 'Mozilla/5.0 TalosDesktop/1.0' },
    }
    mac.top = mac
    expect(whereAmI(iphone)).toBe('iphone')
    expect(whereAmI(mac)).toBe('mac')
    expect(whereAmI({})).toBe('browser')
    expect(whereAmI(android)).toBe('browser')
  })

  it('a pending wipe that kept the queue (session only expired) does not claim the owner signed out', () => {
    render(<StorageRecovery kind="wipe" wipeMode="keep" where="browser" onRetry={vi.fn()} />)
    expect(screen.queryByText(/you signed out here/i)).toBeNull()
    expect(screen.getByText(/session ended/i)).toBeTruthy()
    expect(screen.getByText(/unsent messages are kept/i)).toBeTruthy()
  })

  it('a pending wipe of everything still says the owner signed out', () => {
    render(<StorageRecovery kind="wipe" wipeMode="all" where="browser" onRetry={vi.fn()} />)
    expect(screen.getByText(/you signed out here/i)).toBeTruthy()
  })
})
