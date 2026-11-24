// Settings -> "Always allowed" (always-allow.ts): shown only to a bridge that reads the list, it lists the allowed send kinds
// with the day each was added, and Remove / Remove all write the WHOLE list back through the client's own patchConfig (an
// owner-signed config.patch). Greyed while the Mac is offline or this device is not connected.
import { ALWAYS_ALLOW_FEATURE, type AlwaysAllowEntryT, verifyOwnerFrame } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALWAYS_ALLOWED_EMPTY,
  ALWAYS_ALLOWED_TITLE,
  AlwaysAllowedSection,
} from '../../src/features/settings/AlwaysAllowedSection.tsx'
import { NOT_CONNECTED_LINE } from '../../src/features/settings/offline.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(() => cleanup())

const ADDED = '2026-03-04T12:00:00.000Z'

function mount(opts: {
  feature: boolean
  list?: AlwaysAllowEntryT[] | 'missing'
  macOnline?: boolean
  link?: boolean
  fail?: boolean
}) {
  const client = createFakeClient()
  const s = client.store.getState()
  const features = (s.presence.features ?? []).filter((f) => f !== ALWAYS_ALLOW_FEATURE)
  if (!s.config) throw new Error('the fake client has no config')
  const { always_allow: _drop, ...older } = s.config
  client.store.setState({
    presence: {
      ...s.presence,
      bridge_online: opts.macOnline ?? true,
      features: opts.feature ? [...features, ALWAYS_ALLOW_FEATURE] : features,
    },
    ...(opts.link === false ? { connection: 'reconnecting' as const } : {}),
    config: opts.list === 'missing' ? older : { ...s.config, timezone: 'UTC', always_allow: opts.list ?? [] },
  } as never)
  if (opts.fail) client.failNextPatchWith('config_conflict')
  render(
    <ClientProvider client={client}>
      <AlwaysAllowedSection />
    </ClientProvider>,
  )
  return client
}
const patches = (c: ReturnType<typeof createFakeClient>) => c.sent.filter((f) => f.type === 'config.patch')
const TWO: AlwaysAllowEntryT[] = [
  { kind: 'email', destination: null, added_at: ADDED },
  { kind: 'publish', destination: null },
]

describe('Settings: Always allowed', () => {
  it('lists the new action kinds by name, and Remove writes the rest of the list', async () => {
    const list: AlwaysAllowEntryT[] = [
      { kind: 'generic', destination: null },
      { kind: 'schedule', destination: null },
      { kind: 'undo', destination: null },
      { kind: 'config', destination: null },
    ]
    const client = mount({ feature: true, list })
    for (const name of ['Approvals', 'Schedule changes', 'Undos', 'Settings changes'])
      expect(screen.getByText(name)).toBeTruthy()
    await userEvent.click(
      within(screen.getByTestId('always-allowed').querySelector('[data-kind="undo"]') as HTMLElement).getByRole(
        'button',
        { name: /remove/i },
      ),
    )
    await waitFor(() => expect(patches(client)).toHaveLength(1))
    expect(patches(client)[0]).toMatchObject({ patch: { always_allow: list.filter((e) => e.kind !== 'undo') } })
  })

  it('is hidden from a bridge that does not read the list', () => {
    mount({ feature: false, list: TWO })
    expect(screen.queryByText(ALWAYS_ALLOWED_TITLE)).toBeNull()
    expect(screen.queryByTestId('always-allowed')).toBeNull()
  })

  it('empty: one line saying action cards ask every time, and how a kind gets here', () => {
    mount({ feature: true })
    const box = screen.getByTestId('always-allowed')
    expect(within(box).getByText(ALWAYS_ALLOWED_TITLE)).toBeTruthy()
    expect(box.textContent).toContain(ALWAYS_ALLOWED_EMPTY)
    expect(ALWAYS_ALLOWED_EMPTY).toMatch(/ask every time/)
    expect(ALWAYS_ALLOWED_EMPTY).toMatch(/Always allow/)
    expect(screen.queryByRole('button', { name: 'Remove all' })).toBeNull()
  })

  it('an older config without the key reads as empty', () => {
    mount({ feature: true, list: 'missing' })
    expect(screen.getByTestId('always-allowed').textContent).toContain(ALWAYS_ALLOWED_EMPTY)
  })

  it('lists each kind in words, with the day it was added when known', () => {
    mount({ feature: true, list: TWO })
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['email', 'publish'])
    expect(rows[0]?.textContent).toMatch(/^Emails/)
    expect(rows[0]?.textContent).toMatch(/Added .*2026/)
    expect(rows[1]?.textContent).toMatch(/^Publishing/)
    expect(rows[1]?.textContent).not.toMatch(/Added/)
    expect(screen.getByRole('button', { name: 'Remove emails' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove publishing' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove all' })).toBeTruthy()
  })

  it('Remove sends the whole list minus that kind, as one signed config.patch', async () => {
    const client = mount({ feature: true, list: TWO })
    await userEvent.click(screen.getByRole('button', { name: 'Remove emails' }))
    await waitFor(() => expect(patches(client)).toHaveLength(1))
    const frame = patches(client)[0] as Record<string, unknown>
    expect(frame.patch).toEqual({ always_allow: [{ kind: 'publish', destination: null }] })
    expect(frame).not.toHaveProperty('stepup_token')
    expect(await verifyOwnerFrame(frame, await client.publicJwk())).toBe(true)
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))
    expect(client.store.getState().config?.always_allow).toEqual([{ kind: 'publish', destination: null }])
  })

  it('Remove all sends [] and the empty line comes back', async () => {
    const client = mount({ feature: true, list: TWO })
    await userEvent.click(screen.getByRole('button', { name: 'Remove all' }))
    await waitFor(() => expect(patches(client)).toHaveLength(1))
    expect((patches(client)[0] as Record<string, unknown>).patch).toEqual({ always_allow: [] })
    await waitFor(() => expect(screen.getByTestId('always-allowed').textContent).toContain(ALWAYS_ALLOWED_EMPTY))
  })

  it('a refused change shows why in an alert, and the list stays as saved', async () => {
    const client = mount({ feature: true, list: TWO, fail: true })
    await userEvent.click(screen.getByRole('button', { name: 'Remove all' }))
    expect((await screen.findByRole('alert')).textContent).not.toBe('')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(client.store.getState().config?.always_allow).toHaveLength(2)
  })

  it('Mac offline: the buttons are greyed and say why; nothing is sent', async () => {
    const client = mount({ feature: true, list: TWO, macOnline: false })
    const spy = vi.spyOn(client, 'patchConfig')
    for (const b of screen.getAllByRole('button')) expect(b.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('always-allowed').textContent).toMatch(/has to be online/)
    await act(async () => screen.getByRole('button', { name: 'Remove all' }).click())
    expect(spy).not.toHaveBeenCalled()
  })

  it('this device not connected: greyed, and says so rather than blaming the Mac', () => {
    mount({ feature: true, list: TWO, link: false })
    for (const b of screen.getAllByRole('button')) expect(b.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('always-allowed').textContent).toContain(NOT_CONNECTED_LINE)
  })
})
