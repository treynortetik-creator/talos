// Opening Schedules before the relay has said whether the Mac is there: the page says "Loading…", never "Your computer is
// offline". The client starts with no presence (EMPTY_PRESENCE, bridge_online false) until the relay's ready or presence frame;
// read as "offline", that drew a false offline page for up to half a second on every open with the Mac online (Titan under
// load, 2026-11-19: 8 of 10 opens), and a test that took it for the page's answer lost the list. A relay that cannot be
// reached is an answer: the page says the Mac is offline then, as before.
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulesScreen } from '../../src/features/schedules/index.tsx'
import { ClientProvider, EMPTY_PRESENCE } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { snap } from './variants.ts'

afterEach(cleanup)

/** A client as a phone has it on open: still connecting, no presence yet, no saved list (the cache read is over). */
function opening() {
  const client = createFakeClient()
  client.store.setState((s) => ({
    ...s,
    connection: 'connecting',
    presence: EMPTY_PRESENCE,
    schedules: { ...s.schedules, snapshot: null, status: 'idle', error: null, cacheChecked: true },
  }))
  return client
}
const mount = (client: ReturnType<typeof createFakeClient>) =>
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={['/schedules']}>
        <SchedulesScreen />
      </MemoryRouter>
    </ClientProvider>,
  )

describe('Schedules before the relay has said where the Mac is', () => {
  it('says Loading, not offline, and goes on to the list when the Mac is there', () => {
    const client = opening()
    mount(client)
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    expect(screen.getByText('Loading…')).toBeTruthy()
    act(() =>
      client.store.setState((s) => ({
        ...s,
        connection: 'online',
        presence: { ...EMPTY_PRESENCE, bridge_online: true },
      })),
    )
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    act(() =>
      client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, snapshot: snap(), status: 'ready' } })),
    )
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a presence that says the Mac is away is an answer: offline', () => {
    const client = opening()
    mount(client)
    act(() =>
      client.store.setState((s) => ({ ...s, connection: 'online', presence: { ...EMPTY_PRESENCE, last_seen: null } })),
    )
    expect(screen.getByTestId('empty-mac_offline')).toBeTruthy()
  })

  it('a relay that cannot be reached is an answer too: offline, never an endless Loading', () => {
    for (const connection of ['offline', 'unreachable'] as const) {
      const client = opening()
      const { unmount } = mount(client)
      act(() => client.store.setState((s) => ({ ...s, connection })))
      expect(screen.getByTestId('empty-mac_offline'), connection).toBeTruthy()
      unmount()
    }
  })

  it('a relay that is down stays offline through each retry ("connecting" again), on this page and after leaving it', () => {
    const client = opening()
    const first = mount(client)
    act(() => client.store.setState((s) => ({ ...s, connection: 'unreachable' })))
    expect(screen.getByTestId('empty-mac_offline')).toBeTruthy()
    for (const connection of ['connecting', 'unreachable', 'connecting'] as const) {
      act(() => client.store.setState((s) => ({ ...s, connection })))
      expect(screen.getByTestId('empty-mac_offline'), connection).toBeTruthy()
      expect(screen.queryByText('Loading…'), connection).toBeNull()
    }
    first.unmount()
    mount(client) // back on the tab mid-retry
    expect(screen.getByTestId('empty-mac_offline')).toBeTruthy()
    // the relay answers at last, with the Mac there: Loading until the list comes, never the offline page
    act(() =>
      client.store.setState((s) => ({
        ...s,
        connection: 'online',
        presence: { ...EMPTY_PRESENCE, bridge_online: true },
      })),
    )
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    expect(screen.getByText('Loading…')).toBeTruthy()
  })
})
