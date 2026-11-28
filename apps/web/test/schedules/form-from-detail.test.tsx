// The one place that opens the schedule form with a job (ScheduleDetail: its Edit button, and ?edit=1 from the list): the detail
// is cached and the list row is newer. What the form shows and the revision Save sends are the detail's, the same read, so a Save
// over a job changed elsewhere is refused and cannot carry the new revision over old words.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleDetailScreen } from '../../src/features/schedules/index.tsx'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

describe('Edit opened from the detail screen', () => {
  it.each([
    ['the Edit button', ''],
    ['?edit=1 from the list', '?edit=1'],
  ])("%s: detail at revision A, list row at B: the form shows A's words and Save sends A", async (_n, query) => {
    const client = createFakeClient()
    const snap = await client.schedules.listSchedules()
    const id = snap.schedules[0]?.id as string
    const { detail } = await client.schedules.getSchedule(id, null)
    const A = detail.schedule.etag
    const B = `sha256:${'b'.repeat(64)}`
    expect(A).not.toBe(B)
    // the job changed elsewhere and the list refreshed: the row is newer than the cached detail
    client.store.setState((s) => ({
      schedules: {
        ...s.schedules,
        snapshot: s.schedules.snapshot && {
          ...s.schedules.snapshot,
          schedules: s.schedules.snapshot.schedules.map((j) =>
            j.id === id ? { ...j, etag: B, name: 'Changed elsewhere', editable: true } : j,
          ),
        },
      },
    }))
    const seen: Array<{ op: string; base_etag?: string }> = []
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      seen.push(change as { op: string; base_etag?: string })
      throw new TalosClientError('schedule_conflict', 'The job changed on your Mac. Reload it and try again.')
    })
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[`/schedules/${id}${query}`]}>
          <Routes>
            <Route path="/schedules/:id" element={<ScheduleDetailScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    if (!query) await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByTestId('schedule-form')
    const name = screen.getByLabelText('Name') as HTMLInputElement
    expect(name.value).toBe(detail.schedule.name)
    await userEvent.clear(name)
    await userEvent.type(name, 'My words')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]?.base_etag).toBe(A)
    expect((await screen.findByRole('alert')).textContent).toBe('The job changed on your Mac. Reload it and try again.')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My words')
  })
})
