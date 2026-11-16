// "Lock Talos settings": shown only to a bridge that reads it, off by default, and written as an ordinary owner-signed
// config.patch (the client's own patchConfig, which signs) both ways, with no passkey. Greyed while the Mac is offline.
import { SETTINGS_LOCK_FEATURE } from '@talos-app/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_LOCK_LABEL, SettingsLockSwitch } from '../../src/features/settings/SettingsLockSwitch.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(() => cleanup())

function mount(opts: {
  feature: boolean
  locked?: boolean | 'missing'
  macOnline?: boolean
  link?: boolean
  fail?: boolean
}) {
  const client = createFakeClient()
  const s = client.store.getState()
  const features = (s.presence.features ?? []).filter((f) => f !== SETTINGS_LOCK_FEATURE)
  client.store.setState({
    presence: {
      ...s.presence,
      bridge_online: opts.macOnline ?? true,
      features: opts.feature ? [...features, SETTINGS_LOCK_FEATURE] : features,
    },
    ...(opts.link === false ? { connection: 'reconnecting' as const } : {}),
    ...(s.config
      ? {
          config:
            opts.locked === 'missing'
              ? (() => {
                  const { settings_lock: _drop, ...older } = s.config as typeof s.config & { settings_lock?: boolean }
                  return older as typeof s.config
                })()
              : { ...s.config, settings_lock: opts.locked ?? false },
        }
      : {}),
  } as never)
  const patch = opts.fail
    ? vi.spyOn(client, 'patchConfig').mockRejectedValue(new Error('nope'))
    : vi.spyOn(client, 'patchConfig').mockResolvedValue(undefined as never)
  render(
    <ClientProvider client={client}>
      <SettingsLockSwitch />
    </ClientProvider>,
  )
  return { patch }
}

describe('Lock Talos settings', () => {
  it('is not offered to a bridge that does not read it', () => {
    mount({ feature: false })
    expect(screen.queryByText(SETTINGS_LOCK_LABEL)).toBeNull()
  })

  it('is off by default, with the exact label, and turns on and off by an ordinary config patch', async () => {
    const { patch } = mount({ feature: true })
    const sw = screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => userEvent.click(sw))
    expect(patch).toHaveBeenLastCalledWith({ settings_lock: true })
    cleanup()
    const again = mount({ feature: true, locked: true })
    const on = screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL })
    expect(on.getAttribute('aria-checked')).toBe('true')
    await act(async () => userEvent.click(on))
    expect(again.patch).toHaveBeenLastCalledWith({ settings_lock: false })
  })

  it('is greyed while the Mac is offline, and says why', () => {
    mount({ feature: true, macOnline: false })
    expect((screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/has to be online to change this/)).toBeTruthy()
  })

  it('an older config without the key reads as off', () => {
    mount({ feature: true, locked: 'missing' })
    expect(screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL }).getAttribute('aria-checked')).toBe('false')
  })

  it('is greyed while this device reconnects, and says so', () => {
    mount({ feature: true, link: false })
    expect((screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Settings can be changed once you/)).toBeTruthy()
  })

  it('a refused change says so as an alert, and the switch stays where the saved config is', async () => {
    mount({ feature: true, fail: true })
    const sw = screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL })
    await act(async () => userEvent.click(sw))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('the help text is read with the switch', () => {
    mount({ feature: true })
    const sw = screen.getByRole('switch', { name: SETTINGS_LOCK_LABEL })
    const desc = document.getElementById(sw.getAttribute('aria-describedby') ?? '')
    expect(desc?.textContent).toMatch(/^Off: when you ask your agent to change a setting/)
  })
})
