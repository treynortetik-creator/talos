// The Schedules page kept readable with many jobs: one collapsed group per thread, the one next job with a live countdown,
// a group for one-offs, filter chips, search past 15 jobs, and an Edit button that reuses the form's own save path.
import type { ScheduleSnapshotT, ScheduleT } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduleDetailScreen, SchedulesScreen } from '../../src/features/schedules/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { health, job, NOW_MS, snap } from './variants.ts'

const base = { today: 'not_due' as const, wait_reason: null, window_ends: null }
const failedRun = {
  run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
  ds: '2026-10-05',
  started_at: '2026-10-05T06:00:00-04:00',
  runner: 'headless' as const,
  trigger: 'clock' as const,
  status: 'failed' as const,
  has_report: true,
}
const jobs = (): ScheduleT[] => [
  job({ id: 'daily-summary', name: 'Daily summary', ...base, next_run: '2026-10-06T07:30:00-04:00' }),
  job({
    id: 'packing-check',
    name: 'Packing check',
    thread_id: 'trip',
    ...base,
    next_run: '2026-10-05T09:00:00-04:00',
  }),
  job({ id: 'hotel-watch', name: 'Hotel watch', thread_id: 'trip', ...base, enabled: false, next_run: null }),
  job({
    id: 'water-plants',
    name: 'Water plants',
    thread_id: 'garden',
    ...base,
    today: 'failed',
    last_run: failedRun,
    next_run: '2026-10-06T08:00:00-04:00',
  }),
  job({
    id: 'renew-passport',
    name: 'Renew passport',
    thread_id: 'trip',
    ...base,
    when: { type: 'once', at: '2026-10-05T08:30' },
    when_text: 'Once on Mon Oct 5 at 8:30 AM',
    next_run: '2026-10-05T08:30:00-04:00',
  }),
]

async function mount(schedules: ScheduleT[] = jobs(), route = '/schedules') {
  const client = createFakeClient()
  const data: ScheduleSnapshotT = snap({ health: health(), schedules })
  client.schedules.setData(data)
  await client.schedules.listSchedules()
  client.store.setState((s) => ({
    ...s,
    threads: [
      ...s.threads,
      ...(['trip', 'garden'] as const).map((id) => ({
        ...(s.threads[0] as (typeof s.threads)[number]),
        id,
        name: id === 'trip' ? 'Trip' : 'Garden',
        order: 9,
      })),
    ],
  }))
  const user = userEvent.setup()
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/schedules" element={<SchedulesScreen />} />
          <Route path="/schedules/:id" element={<ScheduleDetailScreen />} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  )
  return { client, user }
}
const header = (name: RegExp | string) => screen.getByRole('button', { name })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW_MS })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('groups', () => {
  it('start collapsed: a header per thread says its name, job count, next run; no job rows show', async () => {
    await mount()
    for (const key of ['__main__', 'trip']) expect(screen.getByTestId(`thread-group-${key}`)).toBeTruthy()
    const trip = screen.getByTestId('group-toggle-trip')
    expect(trip.getAttribute('aria-expanded')).toBe('false')
    expect(trip.textContent).toContain('Trip')
    expect(within(trip).getByTestId('group-count').textContent).toBe('2 jobs')
    expect(within(trip).getByTestId('group-next').textContent).toMatch(/9:00 AM/)
    expect(screen.queryByTestId('schedule-row-packing-check')).toBeNull()
    expect(screen.getByTestId('group-toggle-__main__').getAttribute('aria-expanded')).toBe('false')
  })

  it('a header opens and closes its group', async () => {
    const { user } = await mount()
    await user.click(screen.getByTestId('group-toggle-trip'))
    expect(screen.getByTestId('group-toggle-trip').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('schedule-row-packing-check')).toBeTruthy()
    await user.click(screen.getByTestId('group-toggle-trip'))
    expect(screen.queryByTestId('schedule-row-packing-check')).toBeNull()
  })

  it('a thread with a failed job opens itself and shows a red dot; the others stay shut', async () => {
    await mount()
    const garden = screen.getByTestId('group-toggle-garden')
    expect(garden.getAttribute('aria-expanded')).toBe('true')
    expect(within(garden).getByTestId('group-failed')).toBeTruthy()
    expect(screen.getByTestId('schedule-row-water-plants')).toBeTruthy()
    expect(within(screen.getByTestId('group-toggle-trip')).queryByTestId('group-failed')).toBeNull()
    expect(screen.getByTestId('group-toggle-trip').getAttribute('aria-expanded')).toBe('false')
  })

  it('a thread with a job waiting on the owner opens itself, with no red dot', async () => {
    const held = jobs().map((s) =>
      s.id === 'packing-check' ? { ...s, today: 'held' as const, changed_outside: true } : s,
    )
    await mount(held)
    const trip = screen.getByTestId('group-toggle-trip')
    expect(trip.getAttribute('aria-expanded')).toBe('true')
    expect(within(trip).queryByTestId('group-failed')).toBeNull()
  })

  it('one-off jobs have a group of their own, not their thread', async () => {
    const { user } = await mount()
    expect(within(screen.getByTestId('group-toggle-oneoff')).getByTestId('group-count').textContent).toBe('1 job')
    await user.click(screen.getByTestId('group-toggle-oneoff'))
    expect(within(screen.getByTestId('thread-group-oneoff')).getByTestId('schedule-row-renew-passport')).toBeTruthy()
    await user.click(screen.getByTestId('group-toggle-trip'))
    expect(within(screen.getByTestId('thread-group-trip')).queryByTestId('schedule-row-renew-passport')).toBeNull()
  })
})

describe('rows', () => {
  it('are one line: name, when, a status dot with its word, and the switch', async () => {
    const { user } = await mount()
    await user.click(screen.getByTestId('group-toggle-__main__'))
    const row = screen.getByTestId('schedule-row-daily-summary')
    expect(row.textContent).toContain('Daily summary')
    expect(row.textContent).toContain('Weekdays at 7:30 AM')
    expect(within(row).getByTestId('row-status').textContent).toMatch(/Pending/)
    expect(within(row).getByRole('switch', { name: 'Daily summary runs on schedule' })).toBeTruthy()
    expect(within(row).getByTestId('row-runner').textContent).toBe('Run by Main') // read out, shown only when it differs
  })

  it('the switch pauses the job through the signed control, as before', async () => {
    const { client, user } = await mount()
    const spy = vi.spyOn(client.schedules, 'controlSchedule')
    await user.click(screen.getByTestId('group-toggle-__main__'))
    await user.click(screen.getByRole('switch', { name: 'Daily summary runs on schedule' }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('pause', 'daily-summary'))
  })

  it('a tap on the row opens the job details', async () => {
    const { user } = await mount()
    await user.click(screen.getByTestId('group-toggle-__main__'))
    await user.click(within(screen.getByTestId('schedule-row-daily-summary')).getByRole('link'))
    expect(await screen.findByTestId('schedule-detail')).toBeTruthy()
  })
})

describe('the next job', () => {
  it('is the only upcoming item at the top, with a countdown that ticks; no 24 h or 12 h list', async () => {
    await mount()
    const next = screen.getByTestId('next-up')
    expect(screen.getAllByTestId('next-up')).toHaveLength(1)
    expect(next.textContent).toContain('Renew passport') // 8:30 is the earliest run after 7:45
    expect(within(next).getByTestId('next-up-countdown').textContent).toBe('in 45 min 00 s')
    vi.setSystemTime(NOW_MS + 5_000)
    await waitFor(() => expect(within(next).getByTestId('next-up-countdown').textContent).toBe('in 44 min 55 s'), {
      timeout: 3000,
    })
    expect(screen.queryByText(/next 24|next 12|upcoming|coming up/i)).toBeNull()
  })

  it('says nothing is coming up when every job is off', async () => {
    await mount(jobs().map((s) => ({ ...s, enabled: false })))
    expect(screen.queryByTestId('next-up')).toBeNull()
  })
})

describe('filter chips', () => {
  const chip = (name: string) => screen.getByRole('button', { name })
  it('Failed shows only failed jobs, in groups that open', async () => {
    const { user } = await mount()
    await user.click(chip('Failed'))
    expect(chip('Failed').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('schedule-row-water-plants')).toBeTruthy()
    expect(screen.queryByTestId('thread-group-trip')).toBeNull()
    await user.click(chip('Failed'))
    expect(screen.getByTestId('thread-group-trip')).toBeTruthy()
  })
  it('Paused or off shows paused and switched-off jobs', async () => {
    const { user } = await mount()
    await user.click(chip('Paused or off'))
    expect(screen.getByTestId('schedule-row-hotel-watch')).toBeTruthy()
    expect(screen.queryByTestId('schedule-row-water-plants')).toBeNull()
  })
  it('One-off shows only the one-off jobs', async () => {
    const { user } = await mount()
    await user.click(chip('One-off'))
    expect(screen.getByTestId('schedule-row-renew-passport')).toBeTruthy()
    expect(screen.queryByTestId('schedule-row-water-plants')).toBeNull()
  })
  it('says so when nothing matches', async () => {
    const { user } = await mount(jobs().filter((s) => s.id !== 'water-plants'))
    await user.click(chip('Failed'))
    expect(screen.getByTestId('filter-empty')).toBeTruthy()
  })
})

describe('search', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      job({ id: `job-${i}`, name: `Job ${i}`, thread_id: 'trip', ...base, next_run: '2026-10-06T08:00:00-04:00' }),
    )
  it('is not there for 15 jobs or fewer', async () => {
    await mount(many(15))
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
  it('stays while it holds text, so it can always be cleared', async () => {
    const { client, user } = await mount(many(16))
    await user.type(screen.getByRole('searchbox'), 'job 1')
    client.schedules.setData(snap({ health: health(), schedules: many(15) }))
    await client.schedules.listSchedules()
    const box = (await screen.findByRole('searchbox')) as HTMLInputElement
    await user.clear(box)
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull())
  })
  it('finds a job by its thread name', async () => {
    const { user } = await mount(many(16))
    await user.type(screen.getByRole('searchbox'), 'trip')
    expect(screen.getByTestId('schedule-row-job-3')).toBeTruthy()
  })
  it('shows past 15 jobs and narrows by name', async () => {
    const { user } = await mount(many(16))
    await user.type(screen.getByRole('searchbox'), 'job 12')
    expect(screen.getByTestId('schedule-row-job-12')).toBeTruthy()
    expect(screen.queryByTestId('schedule-row-job-3')).toBeNull()
  })
})

describe('what the owner opened stays', () => {
  it('a group that opened itself stays open when the failed job is paused, and focus stays on the switch', async () => {
    const { user } = await mount()
    expect(screen.getByTestId('group-toggle-garden').getAttribute('aria-expanded')).toBe('true')
    const sw = screen.getByRole('switch', { name: 'Water plants runs on schedule' })
    await user.click(sw)
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Water plants runs on schedule' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    )
    expect(screen.getByTestId('group-toggle-garden').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Water plants runs on schedule' }))
  })

  it('a group the owner shut stays shut through updates, and a new failure only shows its red dot', async () => {
    const { client, user } = await mount()
    await user.click(screen.getByTestId('group-toggle-garden')) // shut the auto-opened one
    await user.click(screen.getByTestId('group-toggle-trip')) // open then shut Trip
    await user.click(screen.getByTestId('group-toggle-trip'))
    const next = jobs().map((s) =>
      s.id === 'packing-check' ? { ...s, today: 'failed' as const, last_run: failedRun } : s,
    )
    client.schedules.setData(snap({ health: health(), schedules: next }))
    await client.schedules.listSchedules()
    await waitFor(() =>
      expect(within(screen.getByTestId('group-toggle-trip')).getByTestId('group-failed')).toBeTruthy(),
    )
    expect(screen.getByTestId('group-toggle-trip').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('group-toggle-garden').getAttribute('aria-expanded')).toBe('false')
  })

  it('a filter survives opening a job and coming back', async () => {
    const { user } = await mount()
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    await user.click(within(screen.getByTestId('schedule-row-water-plants')).getByRole('link'))
    await screen.findByTestId('schedule-detail')
    await user.click(screen.getByRole('link', { name: 'Back to Schedules' }))
    expect(screen.getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('thread-group-trip')).toBeNull()
  })

  it('matches stay visible inside a group the owner shut while a filter is on', async () => {
    const { user } = await mount()
    await user.click(screen.getByTestId('group-toggle-garden')) // shut
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(screen.getByTestId('schedule-row-water-plants')).toBeTruthy()
  })
})

describe('jobs arrive before the thread list', () => {
  it('a failed job whose thread is not known yet does not leave Main stuck open once threads load', async () => {
    const client = createFakeClient()
    client.schedules.setData(snap({ health: health(), schedules: jobs() }))
    await client.schedules.listSchedules()
    const all = client.store.getState().threads
    client.store.setState((s) => ({ ...s, threads: [] })) // threads not loaded yet: Garden's job folds into Main
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/schedules']}>
          <Routes>
            <Route path="/schedules" element={<SchedulesScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(screen.getByTestId('group-toggle-__main__').getAttribute('aria-expanded')).toBe('true') // shown open for now
    act(() => {
      client.store.setState((s) => ({
        ...s,
        threads: [
          ...all,
          ...(['trip', 'garden'] as const).map((id) => ({
            ...(all[0] as (typeof all)[number]),
            id,
            name: id,
            order: 9,
          })),
        ],
      }))
    })
    await waitFor(() => expect(screen.getByTestId('group-toggle-garden').getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getByTestId('group-toggle-__main__').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('headers and rows say the same thing', () => {
  it('pausing everything leaves no red dot and no next time', async () => {
    const { client } = await mount()
    client.schedules.setData(snap({ health: health({ paused_all: true }), schedules: jobs() }))
    await client.schedules.listSchedules()
    await waitFor(() => expect(screen.queryByTestId('group-failed')).toBeNull())
    expect(screen.queryByTestId('group-next')).toBeNull()
    expect(screen.queryByTestId('next-up')).toBeNull()
  })

  it('a job on hold is never the next job', async () => {
    await mount(jobs().map((s) => (s.id === 'renew-passport' ? { ...s, today: 'held' as const } : s)))
    expect(screen.getByTestId('next-up').textContent).toContain('Packing check')
  })

  it('a failed row shows its glyph beside the dot, and the group shows one too', async () => {
    await mount()
    expect(within(screen.getByTestId('schedule-row-water-plants')).getByTestId('row-glyph').textContent).toBe('✕')
    expect(within(screen.getByTestId('group-toggle-garden')).getByTestId('group-failed').textContent).toContain('✕')
  })

  it('a row says who runs it: marked when it differs from its group, always in words', async () => {
    const { user } = await mount(
      jobs().map((s) => (s.id === 'packing-check' ? { ...s, runner: 'headless' as const } : s)),
    )
    await user.click(screen.getByTestId('group-toggle-trip'))
    const r = within(screen.getByTestId('schedule-row-packing-check')).getByTestId('row-runner')
    expect(r.textContent).toBe('Runs in the background, no session')
    expect(r.className).not.toContain('sr-only')
    await user.click(screen.getByTestId('group-toggle-__main__'))
    const same = within(screen.getByTestId('schedule-row-daily-summary')).getByTestId('row-runner')
    expect(same.textContent).toBe('Run by Main')
    expect(same.className).toContain('sr-only')
  })

  it('a shut group still has the list its header controls', async () => {
    await mount()
    const id = screen.getByTestId('group-toggle-trip').getAttribute('aria-controls') as string
    expect(document.getElementById(id)).toBeTruthy()
  })
})

describe('Edit when it cannot', () => {
  it('is disabled with its reason in words when the Mac is offline', async () => {
    const { client, user } = await mount(jobs().map((s) => ({ ...s, editable: true })))
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: false } }))
    await user.click(screen.getByTestId('group-toggle-trip'))
    const b = screen.getByRole('button', { name: 'Edit Packing check' })
    expect(b.hasAttribute('disabled')).toBe(true)
    expect(b.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(b.getAttribute('aria-describedby') as string)?.textContent).toMatch(/offline/i)
  })

  it('?edit=1 on a job the app cannot edit opens the details, not the form', async () => {
    await mount(
      jobs().map((s) => (s.id === 'packing-check' ? { ...s, editable: false } : s)),
      '/schedules/packing-check?edit=1',
    )
    expect(await screen.findByTestId('schedule-detail')).toBeTruthy()
    expect(screen.queryByTestId('schedule-form')).toBeNull()
  })

  it('?edit=1 with the Mac offline opens the details, not the form', async () => {
    const { client } = await mount(
      jobs().map((s) => ({ ...s, editable: true })),
      '/schedules',
    )
    cleanup()
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: false } }))
    render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={['/schedules/packing-check?edit=1']}>
          <Routes>
            <Route path="/schedules/:id" element={<ScheduleDetailScreen />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>,
    )
    expect(await screen.findByTestId('schedule-detail')).toBeTruthy()
    expect(screen.queryByTestId('schedule-form')).toBeNull()
  })
})

describe('Edit', () => {
  it('opens the New form with the job filled in', async () => {
    const { user } = await mount(
      jobs().map((s) =>
        s.id === 'packing-check'
          ? { ...s, model: 'sonnet', notify: 'always' as const, memory: true, editable: true }
          : s,
      ),
    )
    await user.click(screen.getByTestId('group-toggle-trip'))
    await user.click(screen.getByRole('button', { name: 'Edit Packing check' }))
    expect(await screen.findByTestId('schedule-form')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Packing check')
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('sonnet')
    expect((screen.getByLabelText('Tell me') as HTMLSelectElement).value).toBe('always')
    expect((screen.getByLabelText('Posts to') as HTMLSelectElement).value).toBe('trip')
    expect((screen.getByLabelText(/Remember between runs/) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('07:30')
    expect((screen.getByLabelText('What to do') as HTMLTextAreaElement).value.length).toBeGreaterThan(0)
  })

  it('is off for a job the app cannot edit', async () => {
    await mount(jobs().map((s) => (s.id === 'packing-check' ? { ...s, editable: false } : s)))
    await userEvent.setup().click(screen.getByTestId('group-toggle-trip'))
    expect(screen.getByRole('button', { name: 'Edit Packing check' }).hasAttribute('disabled')).toBe(true)
  })

  async function editAndSave(change: (user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
    const { client, user } = await mount(jobs().map((s) => ({ ...s, editable: true })))
    const propose = vi.spyOn(client.schedules, 'proposeScheduleChange')
    await user.click(screen.getByTestId('group-toggle-trip'))
    await user.click(screen.getByRole('button', { name: 'Edit Packing check' }))
    await screen.findByTestId('schedule-form')
    await change(user)
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1))
    const card = await waitFor(() => {
      const c = client.store
        .getState()
        .cards.find((x) => x.kind === 'schedule' && x.state === 'pending' && x.title.includes('Packing'))
      if (!c) throw new Error('no card yet')
      return c
    })
    return { change: propose.mock.calls[0]?.[0], card }
  }

  it('saves through the existing path: the form proposes an update and a card comes back, nothing is written', async () => {
    const { change, card } = await editAndSave(async (user) => {
      const name = screen.getByLabelText('Name')
      await user.clear(name)
      await user.type(name, 'Packing list')
    })
    expect(change).toMatchObject({ op: 'update', id: 'packing-check', set: { name: 'Packing list' } })
    expect(Object.keys((change as { set: object }).set)).toEqual(['name'])
    expect(JSON.stringify(card)).toContain('your form') // proposed by the owner's form, as the detail page's Edit does
  })

  it('keeps the risk ratings: a rename is low, turning memory on is high', async () => {
    const rename = await editAndSave(async (user) => {
      const name = screen.getByLabelText('Name')
      await user.clear(name)
      await user.type(name, 'Packing list')
    })
    expect(rename.card.risk).toBe('low')
    cleanup()
    const mem = await editAndSave(async (user) => {
      await user.click(screen.getByLabelText(/Remember between runs/))
    })
    expect(mem.change).toMatchObject({ op: 'update', set: { memory: true } })
    expect(mem.card.risk).toBe('high')
  })
})
