// Trust mode as a Settings toggle (docs/SECURITY.md "Trust mode"): off is free, on asks for the passkey once, a refusal
// shows its reason and the switch goes back, and an older relay's "not a setting I know" reads as that, not as a crash.
// Against the in-memory fake client, which refuses what the relay refuses (no token for trust on = stepup_required).

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrustModeSwitch } from '../../src/features/settings/TrustModeSwitch.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { PasskeyUnavailableError } from '../../src/lib/passkeyGate.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)
const withConfig = (client: ReturnType<typeof setup>, over: Record<string, unknown>) =>
  client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, ...over } } : s))
const sw = () => screen.getByRole('switch', { name: /Trust mode/ })

describe('Settings: trust mode switch', () => {
  it('says what it changes in one line and starts Off on a config that has no trust_mode', () => {
    renderWith(<TrustModeSwitch />, setup(), '/settings/account')
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('trust-mode-state').textContent).toMatch(/without a card or a passkey/)
    expect(screen.getByTestId('trust-mode-state').textContent).toMatch(/send as you, spend money or delete for good/)
    expect(screen.getByTestId('trust-mode-state').textContent).toMatch(/Turning it on asks for your passkey/)
  })

  it('on: taps the passkey once for config:session, then the config says on', async () => {
    const client = setup()
    const tap = vi.spyOn(client, 'stepup')
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    fireEvent.click(sw())
    await waitFor(() => expect(client.store.getState().config?.trust_mode).toBe(true))
    expect(tap).toHaveBeenCalledTimes(1)
    expect(tap).toHaveBeenCalledWith('config:session')
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('off: no passkey tap at all, and the key leaves the config', async () => {
    const client = setup()
    withConfig(client, { trust_mode: true })
    const tap = vi.spyOn(client, 'stepup')
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    expect(sw().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw())
    await waitFor(() => expect('trust_mode' in (client.store.getState().config ?? {})).toBe(false))
    expect(tap).not.toHaveBeenCalled()
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('a cancelled or unavailable passkey leaves it Off, says why, and sends no patch', async () => {
    const client = setup()
    client.stepup = async () => {
      throw new PasskeyUnavailableError('mac_app')
    }
    const patch = vi.spyOn(client, 'patchConfig')
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    fireEvent.click(sw())
    expect((await screen.findByRole('alert')).textContent).toMatch(/Approve on your phone or in a browser/)
    expect(patch).not.toHaveBeenCalled()
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('an older relay or Mac that does not know the setting: a plain sentence, still Off', async () => {
    const client = setup()
    client.patchConfig = async () => {
      throw new TalosClientError('config_field_forbidden', 'field not allowed: trust_mode')
    }
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    fireEvent.click(sw())
    expect((await screen.findByRole('alert')).textContent).toMatch(/older than this setting/)
    expect(screen.getByRole('alert').textContent).toMatch(/talos-app trust on/)
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('a refusal from the Mac while turning it off keeps it On and shows the reason', async () => {
    const client = setup()
    withConfig(client, { trust_mode: true })
    client.patchConfig = async () => {
      throw new TalosClientError('config_conflict')
    }
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    fireEvent.click(sw())
    expect((await screen.findByRole('alert')).textContent).toMatch(/at the same time/)
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('Mac offline: the switch is disabled and says why (the change goes through the Mac)', () => {
    renderWith(<TrustModeSwitch />, setup({ macOffline: true }), '/settings/account')
    expect(sw().hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('trust-mode-state').textContent).toMatch(/Mac has to be online/)
  })

  it('a trust_mode value this build cannot read shows Off (and the page does not throw)', () => {
    const client = setup()
    withConfig(client, { trust_mode: 'maybe' })
    renderWith(<TrustModeSwitch />, client, '/settings/account')
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('no config yet: renders nothing', () => {
    const client = setup()
    client.store.setState({ config: null } as never)
    const { container } = renderWith(<TrustModeSwitch />, client, '/settings/account')
    expect(container.querySelector('[data-testid="trust-mode-state"]')).toBeNull()
  })
})
