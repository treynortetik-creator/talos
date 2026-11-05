// The rest of the settings home work: Health (connection merged in, relay limits, tool prompts read-only), real limits in
// the copy with a fallback, Integrations (renamed, work thread, work system off, rename and move), Schedules (Pause all,
// description), the phone menu's driving entry, and the Face ID wording.
import { listSetupSpecs } from '@talos-app/integrations/catalog'
import type { HealthStatusT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DropZone } from '../../src/features/composer/DropZone.tsx'
import { tooBigNote } from '../../src/features/composer/uploadError.ts'
import { HealthScreen } from '../../src/features/health/HealthScreen.tsx'
import { limitsLine, noteLimits, resetLimits } from '../../src/features/health/limits.ts'
import { bannerFor, macMessage } from '../../src/features/health/rows.ts'
import { fetchStatus } from '../../src/features/health/useHealthStatus.ts'
import { ConnectionPanel } from '../../src/features/integrations/ConnectionPanel.tsx'
import { IntegrationsScreen } from '../../src/features/integrations/index.tsx'
import { WorkEnableDialog } from '../../src/features/integrations/WorkEnable.tsx'
import { SchedulesScreen } from '../../src/features/schedules/SchedulesScreen.tsx'
import { confirmLabel } from '../../src/lib/confirmLabel.ts'
import { getPlatform } from '../../src/lib/platform.ts'
import { renderWith, setup } from '../cards/helpers.tsx'
import { statusOf } from '../health/status.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetLimits()
})
beforeEach(() => resetLimits())

function stubStatus(over: Partial<HealthStatusT> = {}) {
  const status = { ...statusOf(), ...over }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => status, text: async () => '' }),
  )
}

describe('Health: Connection merged in, relay limits read-only, tool prompts switch', () => {
  it('shows the relay limits as a read-only line that says where to change them, and the tool-prompts state as a switch', async () => {
    stubStatus({ limits: { buffer_days: 3, upload_max_mb: 20, voice_daily_max_min: 45, voice_session_max_min: 15 } })
    const client = setup()
    client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, permission_relay: true } } : s))
    renderWith(<HealthScreen />, client, '/settings/health')
    const ro = screen.getByTestId('health-readonly')
    expect(within(ro).getByTestId('permission-relay-state').textContent).toMatch(/approval cards: On/)
    expect(within(ro).getByTestId('permission-relay-state').textContent).toMatch(/takes effect when the agent restarts/)
    expect(within(ro).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(within(ro).getByTestId('relay-limits')).toBeTruthy())
    expect(within(ro).getByTestId('relay-limits').textContent).toMatch(/messages kept 3 days/)
    expect(within(ro).getByTestId('relay-limits').textContent).toMatch(/uploads up to 20 MB/)
    expect(within(ro).getByTestId('relay-limits').textContent).toMatch(/45 min a day, 15 min per call/)
    expect(ro.querySelectorAll('input, select, button:not([role="switch"])').length).toBe(0) // the limits line has nothing to press; the switch is the only control
    expect(ro.querySelectorAll('[role="switch"]').length).toBe(1)
  })

  it('an older relay that sends no limits shows no limits line, and the page still loads', async () => {
    const { limits: _l, ...old } = { ...statusOf(), limits: undefined }
    stubStatus(old as Partial<HealthStatusT>)
    renderWith(<HealthScreen />, setup(), '/settings/health')
    await waitFor(() => expect(document.querySelector('[data-testid^="health-row-"]')).toBeTruthy())
    expect(screen.queryByTestId('relay-limits')).toBeNull()
  })

  it('the Mac line follows the live connection, not the fetched status', async () => {
    stubStatus()
    const client = setup({ macOffline: true })
    renderWith(<HealthScreen />, client, '/settings/health')
    expect(screen.getByTestId('mac-status').textContent).toMatch(/Mac offline/)
    act(() => client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: true } })))
    expect(screen.getByTestId('mac-status').textContent).toMatch(/Mac online/)
  })
})

describe('limitsLine and the copy that used to hard-code 7 days and 50 MB (M34)', () => {
  it('words the relay’s numbers, one day singular, a zero daily allowance as none', () => {
    expect(limitsLine(undefined)).toBeNull()
    expect(limitsLine({})).toBeNull()
    expect(limitsLine({ buffer_days: 1 })).toBe('messages kept 1 day')
    expect(limitsLine({ voice_daily_max_min: 0, voice_session_max_min: 30 })).toBe(
      'live voice no minutes allowed today, 30 min per call',
    )
  })

  it('the Mac-offline message says the real number of days, and the old 7 days when the relay did not say', () => {
    expect(macMessage('asleep', { bufferDays: 2 }).next).toMatch(/for up to 2 days\./)
    expect(macMessage('dropped', { bufferDays: 1 }).next).toMatch(/for up to 1 day\./)
    expect(macMessage('asleep').next).toMatch(/for up to 7 days\./)
    const s = {
      ...statusOf(),
      limits: { buffer_days: 4 },
      mac_problems: ['bridge_offline'],
      bridge: { online: false, last_seen: null, down_since: null },
    } as unknown as HealthStatusT
    expect(bannerFor(s, false, Date.parse(s.at))?.next).toMatch(/up to 4 days/)
  })

  it('the work dialog and the drop zone use the relay’s numbers once Health has fetched them', async () => {
    stubStatus({ limits: { buffer_days: 2, upload_max_mb: 10 } })
    await fetchStatus()
    expect(tooBigNote()).toBe('Too big to send (max 10 MB)')
    const client = setup()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, work: { ...s.config.work, retention: 'buffer' } } } : s,
    )
    const spec = listSetupSpecs().find((x) => x.id === 'slack')
    if (!spec) throw new Error('slack missing from the catalog')
    renderWith(<WorkEnableDialog spec={spec as never} readOnly={false} onClose={() => {}} />, client)
    expect((await screen.findByRole('dialog')).textContent).toMatch(/up to 2 days/)
    cleanup()
    const { container } = render(
      <DropZone threadId="general">
        <p>x</p>
      </DropZone>,
    )
    fireEvent.dragEnter(container.firstChild as Element, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByTestId('drop-overlay').textContent).toMatch(/Max 10 MB each/)
  })

  it('with nothing known the old wording stays', () => {
    expect(tooBigNote()).toBe('Too big to send (max 50 MB)')
    noteLimits({ upload_max_mb: 5 })
    expect(tooBigNote()).toBe('Too big to send (max 5 MB)')
    noteLimits(undefined) // a later status from an older relay forgets the number rather than keeping a stale one
    expect(tooBigNote()).toBe('Too big to send (max 50 MB)')
  })
})

describe('confirmLabel (M10)', () => {
  it('says Face ID only on an iPhone', () => {
    vi.spyOn(getPlatform(), 'isIos').mockReturnValue(true)
    expect(confirmLabel()).toBe('Confirm with Face ID')
    vi.spyOn(getPlatform(), 'isIos').mockReturnValue(false)
    expect(confirmLabel()).toBe("Confirm it's you")
  })
})

describe('Integrations', () => {
  it('is called Integrations everywhere, with the Mac-offline note it could never show before (U11)', async () => {
    renderWith(<IntegrationsScreen />, setup({ macOffline: true }))
    expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add an integration' })).toBeTruthy()
    expect(screen.queryByText(/Webhooks/)).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/Mac is offline/)
  })

  it('M9: the work thread lives here, saves at once, and says it is only the starting choice', async () => {
    const client = setup()
    renderWith(<IntegrationsScreen />, client)
    const box = await screen.findByTestId('work-thread')
    expect(box.textContent).toMatch(/Connections you already added keep their own thread/)
    await userEvent.selectOptions(within(box).getByRole('combobox'), 'general')
    await waitFor(() => expect(client.store.getState().config?.work.thread).toBe('general'))
    expect((client.sent.at(-1) as { patch: unknown }).patch).toEqual({ work: { thread: 'general' } })
    await userEvent.selectOptions(within(box).getByRole('combobox'), '')
    await waitFor(() => expect(client.store.getState().config?.work.thread).toBeUndefined())
    expect((client.sent.at(-1) as { patch: unknown }).patch).toEqual({ work: { thread: null } })
    client.failNextPatchWith('config_conflict')
    await userEvent.selectOptions(within(box).getByRole('combobox'), 'general')
    expect((await within(box).findByRole('alert')).textContent).toBeTruthy()
    expect((within(box).getByRole('combobox') as HTMLSelectElement).value).toBe('') // back on the saved value
  })

  it('Agent no longer has the work thread: nothing else writes work.thread', async () => {
    const { AgentSettingsSection } = await import('../../src/features/agent-config/AgentSettingsSection.tsx')
    renderWith(<AgentSettingsSection readOnly={false} />, setup())
    expect(screen.queryByText(/Work systems thread/)).toBeNull()
  })

  it('the work-system Turn off button opens the disable dialog when the Mac is offline too (it says so, no change sent)', async () => {
    const client = setup({ macOffline: true })
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, work: { ...s.config.work, enabled: ['slack'] } } } : s,
    )
    renderWith(<IntegrationsScreen />, client)
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off Slack' }))
    expect((await screen.findByRole('button', { name: 'Mac is offline' })).hasAttribute('disabled')).toBe(true)
    expect(client.sent).toHaveLength(0)
  })

  it('a connection can be renamed and moved to another thread', async () => {
    const client = setup()
    const conn = {
      id: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
      integration: 'generic',
      name: 'Build hooks',
      thread: 'general',
      status: 'active',
      filters: {},
      received_24h: 0,
      kept_24h: 0,
      last_event_at: null,
    } as never
    const patch = vi.fn(
      async (_id: string, body: Record<string, unknown>) => ({ ...(conn as object), ...body }) as never,
    )
    client.api.connections.patch = patch as never
    const changed = vi.fn()
    renderWith(<ConnectionPanel conn={conn} spec={undefined} onChange={changed} onDisconnected={() => {}} />, client)
    const box = screen.getByTestId('conn-edit')
    const name = within(box).getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'CI hooks')
    await userEvent.click(within(box).getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('cn_8fK2aBcDeFgHiJkLmNoPqR', { name: 'CI hooks' }))
    await userEvent.selectOptions(within(box).getByLabelText('Posts to'), 'inbox')
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('cn_8fK2aBcDeFgHiJkLmNoPqR', { thread: 'inbox' }))
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('a rename the server refuses says so and keeps the old name', async () => {
    const client = setup()
    const conn = {
      id: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
      integration: 'generic',
      name: 'Build hooks',
      thread: 'general',
      status: 'active',
      filters: {},
      received_24h: 0,
      kept_24h: 0,
      last_event_at: null,
    } as never
    client.api.connections.patch = (async () => {
      throw new Error('nope')
    }) as never
    renderWith(<ConnectionPanel conn={conn} spec={undefined} onChange={() => {}} onDisconnected={() => {}} />, client)
    await userEvent.type(screen.getByLabelText('Name'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not go through/)
  })
})

describe('Pause all and the description field (schedules)', () => {
  const snapshotWith = (client: ReturnType<typeof setup>, paused_all: boolean) => {
    const base = {
      as_of: '2026-10-30T10:00:00.000Z',
      health: { state: 'ok', paused_all, issues: [] },
      schedules: [
        {
          id: 'a',
          name: 'Morning',
          enabled: true,
          paused: false,
          kind: 'prompt',
          when: { type: 'daily', time: '07:00' },
          thread_id: null,
          etag: 'e1',
        },
      ],
      unreadable: [],
    }
    client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, snapshot: base as never } }))
  }

  it('Pause all asks first, then sends one pause_all with no job id', async () => {
    const client = setup()
    snapshotWith(client, false)
    const control = vi.fn(async () => {})
    ;(client as unknown as { schedules: { controlSchedule: unknown } }).schedules.controlSchedule = control
    render(
      <MemoryRouter>
        <SchedulesProbe client={client} />
      </MemoryRouter>,
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Pause all' }))
    expect(control).not.toHaveBeenCalled()
    await userEvent.click(
      within(await screen.findByTestId('pause-all-sheet')).getByRole('button', { name: 'Pause all jobs' }),
    )
    await waitFor(() => expect(control).toHaveBeenCalledWith('pause_all', null))
  })

  it('is not offered when everything is already paused, or the Mac is offline (disabled)', async () => {
    const client = setup()
    snapshotWith(client, true)
    render(
      <MemoryRouter>
        <SchedulesProbe client={client} />
      </MemoryRouter>,
    )
    await screen.findByTestId('schedules-screen')
    expect(screen.queryByRole('button', { name: 'Pause all' })).toBeNull()
  })
})

import { ClientProvider } from '../../src/lib/client.ts'

function SchedulesProbe({ client }: { client: ReturnType<typeof setup> }) {
  return (
    <ClientProvider client={client}>
      <SchedulesScreen />
    </ClientProvider>
  )
}
