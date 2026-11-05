// R4: D53 text size, D48 the Mac's notification row, D62 Copy diagnostics.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentConfig, PROTOCOL_VERSION } from '@talos-app/protocol'
import readyFixture from '@talos-app/protocol/fixtures/frames/ready.json'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useSession } from '../../src/features/auth/session.ts'
import { diagnosticsText, macAppVersion } from '../../src/features/health/diagnostics.ts'
import { HealthScreen } from '../../src/features/health/HealthScreen.tsx'
import { attachShell } from '../../src/features/native/attach.ts'
import { AppearanceSection, NotificationsSection } from '../../src/features/settings/sections.tsx'
import { ClientProvider, initialClientState, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { createShellBridge } from '../../src/lib/native/bridge.ts'
import { setMacNotifyPermission } from '../../src/lib/native/notifyPermission.ts'
import type { Shell } from '../../src/lib/native/shell.ts'
import { applyTheme, getTextSize, setTextSize, TEXT_SIZE_PERCENT } from '../../src/lib/theme.ts'
import { statusOf } from '../health/status.ts'

const theme = (f: string) => readFileSync(join(import.meta.dirname, '../../src/theme', f), 'utf8')
const detect = vi.hoisted(() => ({ kind: 'none' as 'none' | 'desktop' }))
vi.mock('../../src/lib/native/detect.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/native/detect.ts')>()),
  detectShell: () => detect.kind,
}))

beforeEach(() => {
  detect.kind = 'none'
  setMacNotifyPermission('unknown')
  localStorage.clear()
  document.documentElement.style.removeProperty('font-size')
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Text size (D53)', () => {
  it('sets the root font size, so every rem token and Tailwind spacing scales with it', async () => {
    render(
      <ClientProvider client={createFakeClient()}>
        <AppearanceSection readOnly={false} />
      </ClientProvider>,
    )
    const group = screen.getByRole('radiogroup', { name: 'Text size' })
    expect(group).toBeTruthy()
    await userEvent.click(screen.getByRole('radio', { name: 'Largest' }))
    expect(document.documentElement.style.fontSize).toBe(`${TEXT_SIZE_PERCENT.largest}%`)
    expect(screen.getByRole('radio', { name: 'Largest' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.click(screen.getByRole('radio', { name: 'Default' }))
    expect(document.documentElement.style.fontSize).toBe('') // back to exactly what it was before the control
  })

  it('is kept per device and applied on launch by applyTheme (what main.tsx calls)', () => {
    setTextSize('larger')
    expect(localStorage.getItem('talos-text-size')).toBe('larger')
    document.documentElement.style.removeProperty('font-size')
    applyTheme()
    expect(document.documentElement.style.fontSize).toBe('130%')
    expect(getTextSize()).toBe('larger')
  })

  it('a stored value that is not a size is ignored, and changing the theme keeps the size', () => {
    localStorage.setItem('talos-text-size', 'huge')
    expect(getTextSize()).toBe('default')
    setTextSize('large')
    applyTheme('dark')
    expect(document.documentElement.style.fontSize).toBe('115%')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('sizes are rem-driven: the tokens are rem and the global font shorthand is not used', () => {
    expect(theme('tokens.css')).toMatch(/--text-md: 1rem/)
    expect(theme('app.css')).not.toMatch(/-apple-system-body/)
  })
})

function renderNotifications() {
  return render(
    <ClientProvider client={createFakeClient()}>
      <MemoryRouter>
        <NotificationsSection readOnly={false} />
      </MemoryRouter>
    </ClientProvider>,
  )
}

describe('Mac notifications row (D48)', () => {
  it('a browser still gets the web push row', () => {
    renderNotifications()
    expect(screen.getByTestId('push-status')).toBeTruthy()
    expect(screen.queryByTestId('mac-banners')).toBeNull()
  })

  it('the Mac app never says "Not supported here"; it says what it does and what macOS says', () => {
    detect.kind = 'desktop'
    renderNotifications()
    expect(screen.queryByText(/Not supported here/)).toBeNull()
    expect(screen.queryByTestId('push-status')).toBeNull()
    expect(screen.getByTestId('mac-banners').textContent).toMatch(/window isn't in front/)
    cleanup()
    for (const [state, text] of [
      ['granted', /Allowed in macOS/],
      ['denied', /Blocked.*System Settings/],
      ['not_asked', /Not asked yet/],
    ] as const) {
      setMacNotifyPermission(state)
      renderNotifications()
      expect(screen.getByTestId('mac-banner-status').textContent).toMatch(text)
      cleanup()
    }
  })

  it('the shell message reaches the row through the real bridge, and an unknown value is refused', async () => {
    detect.kind = 'desktop'
    const config = AgentConfig.parse(readyFixture.agent_config)
    const bridge = createShellBridge({ post: () => {} })
    const store = createStore(() => ({ ...initialClientState(), config, threads: config.threads }))
    const client = { store, onFrame: () => () => {} } as unknown as TalosClient
    useSession.setState({ status: 'anon' })
    attachShell({ kind: 'desktop', bridge, platform: {} } as unknown as Shell, client)
    renderNotifications()
    expect(screen.getByTestId('mac-banner-status').getAttribute('data-permission')).toBe('unknown')
    act(() => void bridge.receive(JSON.stringify({ type: 'notify_permission', state: 'denied' })))
    await waitFor(() => expect(screen.getByTestId('mac-banner-status').getAttribute('data-permission')).toBe('denied'))
    let accepted: boolean | Promise<boolean> = true
    act(() => {
      accepted = bridge.receive(JSON.stringify({ type: 'notify_permission', state: 'maybe' }))
    })
    expect(accepted).toBe(false)
    expect(screen.getByTestId('mac-banner-status').getAttribute('data-permission')).toBe('denied') // unchanged
  })
})

describe('Copy diagnostics (D62)', () => {
  it('holds versions and the content-free status, and nothing else', () => {
    const text = diagnosticsText({
      app: '1.2.3',
      protocol: 7,
      where: 'Mac app',
      at: '2026-11-01T10:00:00.000Z',
      rows: [{ id: 'bridge', label: 'Mac bridge', tone: 'warn', detail: 'offline since 09:00' }],
    })
    expect(text).toContain('App: 1.2.3')
    expect(text).toContain('Protocol: v7')
    expect(text).toContain('Running in: Mac app')
    expect(text).toContain('Mac bridge: Needs a look - offline since 09:00')
  })

  it('shows the Mac app version, the relay version, the notes, and that an old Mac app never reported (D62)', () => {
    const text = diagnosticsText({
      app: '1.2.3',
      protocol: 7,
      where: 'Mac app',
      at: null,
      rows: [],
      macApp: macAppVersion('Mozilla/5.0 AppleWebKit/605 TalosDesktop/0.9.1'),
      relay: '2.4.0',
      macNotify: 'unknown',
      notes: ['Voice replies need a TTS command on your Mac'],
    })
    expect(text).toContain('Mac app: 0.9.1')
    expect(text).toContain('Relay version: 2.4.0')
    expect(text).toContain('Mac notifications: no report from the Mac app')
    expect(text).toContain('Note: Voice replies need a TTS command on your Mac')
    expect(macAppVersion('Mozilla/5.0 Safari')).toBeNull()
    expect(macAppVersion('Mozilla/5.0 TalosDesktop/1.0 evil')).toBe('1.0')
  })

  function renderHealth() {
    const client = createFakeClient()
    return render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <HealthScreen />
        </MemoryRouter>
      </ClientProvider>,
    )
  }

  it('the button copies the text to the clipboard and says so', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 TalosDesktop/0.9.1', clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(statusOf()), { status: 200 })),
    )
    renderHealth()
    await screen.findByTestId('health-row-relay')
    await userEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    const sent = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(sent).toContain(`Protocol: v${PROTOCOL_VERSION}`)
    expect(sent).toContain('Running in: Browser')
    expect(sent).toContain('Mac app: 0.9.1') // the version reaches the pasted text through the real button
    expect(sent).toMatch(/Relay version: \S+/)
    expect(sent).toContain('Relay: OK')
    expect((await screen.findByRole('status')).textContent).toMatch(/Copied/)
  })

  it('a blocked clipboard is reported, never shown as copied', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(statusOf()), { status: 200 })),
    )
    renderHealth()
    await screen.findByTestId('health-row-relay')
    await userEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't copy/)
    expect(screen.queryByText(/^Copied/)).toBeNull()
  })
})
