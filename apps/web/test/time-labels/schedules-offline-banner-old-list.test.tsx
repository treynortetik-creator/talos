// Schedules, Mac offline: the banner says how old the cached list is, "This list is from 7:45 AM." It is built from
// `t.time(snap.as_of)` (SchedulesScreen.tsx:151), a bare clock time. The list is kept on the device (IndexedDB), so after a
// weekend with the Mac asleep the banner still reads "from 7:45 AM", as if it were this morning's.
// The test clock is 2026-10-28; the fixture snapshot is from 2026-10-05, 23 days earlier. The scheduler's zone comes from the snapshot.
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { SchedulesScreen } from '../../src/features/schedules/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { health, job, snap } from '../schedules/variants.ts'

afterEach(cleanup)

describe('the offline banner over a list from an earlier day', () => {
  it('says the day the list is from, not only a clock time', async () => {
    const client = createFakeClient()
    const data = snap({
      as_of: '2026-10-05T07:45:00-04:00',
      health: health(),
      schedules: [job({ id: 'daily-summary', name: 'Daily summary', today: 'not_due', wait_reason: null })],
    })
    client.schedules.setData(data)
    await client.schedules.listSchedules()
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: false } }))
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/schedules']}>
          <Routes>
            <Route path="/schedules" element={<SchedulesScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    const banner = await screen.findByTestId('offline-banner')
    expect(Date.now() - Date.parse(data.as_of)).toBeGreaterThan(20 * 86_400_000) // the list really is weeks old
    // expected: "This list is from Oct 5, 7:45 AM." (whenLabel already has that form)
    expect(banner.textContent).toMatch(/Oct 5/)
  })
})
