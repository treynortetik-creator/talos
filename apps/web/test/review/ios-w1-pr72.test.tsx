// Independent review of PR #72 (iPhone WP-W1). Each test pins a finding through the real modules: the real
// capacitorPlatform installer, the real shell detector and the real LoginPage. They fail on d717e0c.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { LoginPage } from '../../src/features/auth/LoginPage.tsx'
import { installNativePlatform } from '../../src/lib/capacitorPlatform.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { isNativeShell } from '../../src/lib/native.ts'
import { getPlatform, setPlatform, webPlatform } from '../../src/lib/platform.ts'

const g = globalThis as { Capacitor?: unknown }
afterEach(() => {
  cleanup()
  delete g.Capacitor
  setPlatform(webPlatform)
})

describe('F1 the login page in the iPhone shell offers only a passkey, which the shell cannot do', () => {
  it('after sign out or session expiry the iPhone app shows no passkey button', () => {
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    expect(isNativeShell()).toBe(true)
    render(
      <ClientProvider client={createFakeClient()}>
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(screen.queryByRole('button', { name: /passkey/i })).toBeNull()
  })
})

describe('F2 any Capacitor platform, not just iOS, takes the setup-code path and the shell adapter', () => {
  it('an Android Capacitor web view is not treated as the iPhone shell', () => {
    const scope = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }
    // runEnrollment and EnrollPage branch on isNativeShell(); installNativePlatform reports installed.
    expect(isNativeShell(scope)).toBe(false)
    expect(installNativePlatform(scope)).toBe(false)
    expect(getPlatform().installState()).not.toBe('installed')
  })
})

describe('F3 detection is not limited to the top frame', () => {
  it('a Capacitor global seen from a child frame does not count as the shell', () => {
    const scope: Record<string, unknown> = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }
    scope.top = {} // a child frame: top is another window
    expect(installNativePlatform(scope)).toBe(false)
  })
})
