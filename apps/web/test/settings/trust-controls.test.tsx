// Phone controls added with trust mode: the permission-relay switch (Health) and the work wording and retention (Work
// systems). Against the in-memory fake client. None of them asks for a passkey (owner ruling 2026-11-14), trust mode or not.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HealthScreen } from '../../src/features/health/HealthScreen.tsx'
import { PermissionRelaySwitch } from '../../src/features/health/PermissionRelaySwitch.tsx'
import { WorkWording } from '../../src/features/integrations/WorkWording.tsx'
import { NOT_CONNECTED_LINE } from '../../src/features/settings/offline.ts'
import { renderWith, setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubStatus() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => statusOf(), text: async () => '' }),
  )
}
const withConfig = (client: ReturnType<typeof setup>, over: Record<string, unknown>) =>
  client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, ...over } } : s))

describe('Health: the permission relay switch', () => {
  it('shows the saved state, and a change saves as one signed patch with no passkey', async () => {
    stubStatus()
    const client = setup()
    withConfig(client, { permission_relay: false })
    renderWith(<HealthScreen />, client, '/settings/health')
    const row = screen.getByTestId('permission-relay-state')
    expect(row.textContent).toMatch(/approval cards: Off/)
    const sw = within(row).getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    await waitFor(() => expect(client.store.getState().config?.permission_relay).toBe(true))
    expect(client.sent.at(-1)).toMatchObject({ type: 'config.patch', patch: { permission_relay: true } })
    expect(client.sent.at(-1)).not.toHaveProperty('stepup_token')
    expect((await screen.findByRole('status')).textContent).toMatch(/Restart the agent/)
    expect(within(screen.getByTestId('permission-relay-state')).getByRole('switch').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  // 2026-11-03: the app said On while Claude Code, started with the relay off, never sent a prompt to Talos.
  const stubBeat = (declared: boolean | undefined) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ...statusOf(),
          beat: { ...statusOf().beat, ...(declared === undefined ? {} : { permission_relay_declared: declared }) },
        }),
        text: async () => '',
      }),
    )

  it('saved On but the running session did not declare it: says "On after restart" and where to restart', async () => {
    stubBeat(false)
    const client = setup()
    withConfig(client, { permission_relay: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    const row = screen.getByTestId('permission-relay-state')
    await waitFor(() => expect(row.textContent).toMatch(/approval cards: On after restart/))
    expect(row.textContent).toMatch(/Restart session/)
    // not every session was started by the Mac app (its menu item is then off): the terminal way is named too
    expect(row.textContent).toMatch(/quit and restart Claude Code in your terminal/)
    expect(row.textContent).not.toMatch(/cards: On(?! after)/)
  })

  it('one poller: opening Health asks /api/status once, not once for the page and once for the switch', async () => {
    stubStatus()
    const client = setup()
    withConfig(client, { permission_relay: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    await waitFor(() => expect(document.querySelectorAll('[data-testid^="health-row-"]').length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('/api/status'),
    )
    expect(calls.length).toBe(1)
  })

  it('the switch is driven by what it is given and asks for nothing itself', () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const client = setup()
    withConfig(client, { permission_relay: true })
    renderWith(<PermissionRelaySwitch declared={false} />, client, '/settings/health')
    expect(screen.getByTestId('permission-relay-state').textContent).toMatch(/On after restart/)
    cleanup()
    renderWith(<PermissionRelaySwitch declared={true} />, client, '/settings/health')
    expect(screen.getByTestId('permission-relay-state').textContent).not.toMatch(/after restart/)
    cleanup()
    renderWith(<PermissionRelaySwitch />, client, '/settings/health')
    expect(screen.getByTestId('permission-relay-state').textContent).not.toMatch(/after restart/)
    expect(f).not.toHaveBeenCalled()
  })

  it('saved On and declared: plain On, no restart wording', async () => {
    stubBeat(true)
    const client = setup()
    withConfig(client, { permission_relay: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    await waitFor(() => expect(screen.getByTestId('permission-relay-state').textContent).toMatch(/cards: On/))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId('permission-relay-state').textContent).not.toMatch(/after restart/)
  })

  it('an older bridge that reports nothing: plain On (nothing known, nothing claimed)', async () => {
    stubBeat(undefined)
    const client = setup()
    withConfig(client, { permission_relay: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId('permission-relay-state').textContent).not.toMatch(/after restart/)
  })

  it('trust mode: the same, it saves', async () => {
    stubStatus()
    const client = setup()
    withConfig(client, { permission_relay: false, trust_mode: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    fireEvent.click(within(screen.getByTestId('permission-relay-state')).getByRole('switch'))
    await waitFor(() => expect(client.store.getState().config?.permission_relay).toBe(true))
  })

  it('a refused change shows the reason and the switch goes back', async () => {
    stubStatus()
    const client = setup()
    withConfig(client, { permission_relay: false })
    client.patchConfig = async () => {
      throw new Error('Your Mac said no')
    }
    renderWith(<HealthScreen />, client, '/settings/health')
    fireEvent.click(within(screen.getByTestId('permission-relay-state')).getByRole('switch'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Your Mac said no/)
    expect(within(screen.getByTestId('permission-relay-state')).getByRole('switch').getAttribute('aria-checked')).toBe(
      'false',
    )
  })

  it('with the Mac offline (this device connected) the switch is disabled and says the Mac is offline', async () => {
    stubStatus()
    const client = setup({ macOffline: true })
    withConfig(client, { permission_relay: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    const row = screen.getByTestId('permission-relay-state')
    expect(within(row).getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(row.textContent).toMatch(/is offline, so this can’t change now/)
  })

  it('with this device not connected the switch is disabled and says so, never that the Mac is offline', async () => {
    stubStatus()
    const client = setup({ macOffline: true }) // the last word about the Mac, from before the drop: not current
    withConfig(client, { permission_relay: true })
    client.store.setState({ connection: 'offline' } as never)
    renderWith(<HealthScreen />, client, '/settings/health')
    const row = screen.getByTestId('permission-relay-state')
    expect(within(row).getByRole('switch').hasAttribute('disabled')).toBe(true)
    expect(row.textContent).toContain(NOT_CONNECTED_LINE)
    expect(row.textContent).not.toMatch(/is offline/)
  })
})

describe('Health: this device not connected', () => {
  it('the header never says the Mac is offline from a stale presence, and says its status is from before', async () => {
    stubStatus()
    const client = setup({ macOffline: true }) // last heard: Mac offline, then this device lost its connection
    client.store.setState({ connection: 'offline' } as never)
    renderWith(<HealthScreen />, client, '/settings/health')
    const mac = await screen.findByTestId('mac-status')
    expect(mac.textContent).toContain('not known until connected')
    expect(mac.textContent).not.toMatch(/Mac (online|offline)/)
    expect(screen.getByTestId('health-not-connected').textContent).toContain(NOT_CONNECTED_LINE)
  })

  it('connected, the header says what the Mac is, and the line is gone', async () => {
    stubStatus()
    const client = setup({ macOffline: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    expect((await screen.findByTestId('mac-status')).textContent).toContain('Mac offline')
    expect(screen.queryByTestId('health-not-connected')).toBeNull()
  })
})

describe('Work systems: wording and retention', () => {
  it('saves the wording and shows it', async () => {
    const client = setup()
    renderWith(<WorkWording readOnly={false} />, client, '/settings/integrations')
    const save = screen.getByRole('button', { name: 'Save wording' })
    expect(save.hasAttribute('disabled')).toBe(true) // nothing changed yet
    fireEvent.change(screen.getByLabelText('What to call work systems'), { target: { value: 'Office tools' } })
    fireEvent.click(save)
    await waitFor(() => expect(client.store.getState().config?.work.label).toBe('Office tools'))
    expect((await screen.findByRole('status')).textContent).toBe('Saved.')
  })

  it('an empty name is refused in words and nothing is sent', async () => {
    const client = setup()
    const patch = vi.spyOn(client, 'patchConfig')
    renderWith(<WorkWording readOnly={false} />, client, '/settings/integrations')
    fireEvent.change(screen.getByLabelText('What to call work systems'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save wording' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/can’t be empty/)
    expect(patch).not.toHaveBeenCalled()
  })

  it('retention saves at once as one signed patch, with no passkey', async () => {
    const client = setup()
    renderWith(<WorkWording readOnly={false} />, client, '/settings/integrations')
    fireEvent.change(screen.getByLabelText('Events from work systems'), { target: { value: 'buffer' } })
    await waitFor(() => expect(client.store.getState().config?.work.retention).toBe('buffer'))
    expect(client.sent.at(-1)).toMatchObject({ type: 'config.patch', patch: { work: { retention: 'buffer' } } })
    expect(client.sent.at(-1)).not.toHaveProperty('stepup_token')
  })

  it('read-only (Mac offline): every control is disabled', () => {
    renderWith(<WorkWording readOnly />, setup(), '/settings/integrations')
    for (const el of [
      screen.getByLabelText('What to call work systems'),
      screen.getByLabelText('Note shown before connecting one'),
      screen.getByLabelText('Events from work systems'),
    ])
      expect(el.hasAttribute('disabled')).toBe(true)
  })
})
