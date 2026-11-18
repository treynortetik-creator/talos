// A cold start with the Mac away: the list saved on this device is read from IndexedDB, which takes a moment. Until that
// read is over the page says "Loading…", never "Your Mac is offline" with no list (a flash a test, or a person, could act on
// before the saved list drew).
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulesScreen } from '../../src/features/schedules/index.tsx'
import { loadCached } from '../../src/features/schedules/sync.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import type { Storage } from '../../src/lib/storage.ts'
import { snap } from './variants.ts'

afterEach(cleanup)

function away() {
  const client = createFakeClient()
  client.store.setState((s) => ({
    ...s,
    presence: { ...s.presence, bridge_online: false },
    schedules: { ...s.schedules, snapshot: null, status: 'idle', error: null, cacheChecked: false },
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

/** A storage whose read waits until the test lets it answer. */
function slowStorage(value: unknown) {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const storage = {
    get: async () => {
      await gate
      return value
    },
  } as unknown as Storage
  return { storage, release }
}

describe('Schedules, Mac away, saved list not read yet', () => {
  it('says Loading while the saved list is being read, then draws it', async () => {
    const client = away()
    const { storage, release } = slowStorage({ snapshot: snap() })
    mount(client)
    const read = loadCached(client, storage)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    release()
    await read
    expect(client.store.getState().schedules.snapshot).not.toBeNull()
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
  })

  it('with nothing saved, the read ending is what lets the page say the Mac is offline', async () => {
    const client = away()
    const { storage, release } = slowStorage(undefined)
    mount(client)
    const read = loadCached(client, storage)
    expect(screen.queryByTestId('empty-mac_offline')).toBeNull()
    release()
    await read
    expect(await screen.findByTestId('empty-mac_offline')).toBeTruthy()
  })

  it('a read that never answers ends the wait after the look limit: the page says the Mac is offline, and a late answer still draws', async () => {
    const client = away()
    const { storage, release } = slowStorage({ snapshot: snap() })
    mount(client)
    let giveUp!: () => void
    const read = loadCached(client, storage, (f) => {
      giveUp = f // the test plays the look limit (CACHE_LOOK_MS), not a real 2 s
      return undefined
    })
    expect(screen.getByText('Loading…')).toBeTruthy()
    giveUp()
    expect(await screen.findByTestId('empty-mac_offline')).toBeTruthy()
    release() // the read answers after all: the saved list draws
    await read
    expect(client.store.getState().schedules.snapshot).not.toBeNull()
  })

  it('a read that fails ends the wait too, never an endless Loading', async () => {
    const client = away()
    mount(client)
    await loadCached(client, {
      get: async () => {
        throw new Error('storage unavailable')
      },
    } as unknown as Storage)
    expect(await screen.findByTestId('empty-mac_offline')).toBeTruthy()
  })
})
