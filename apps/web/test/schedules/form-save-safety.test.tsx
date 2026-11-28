// The schedule form's Save is safe to press again and cannot overwrite an edit made elsewhere:
//  - an update carries the revision the form was OPENED on, never the live row (another tab or an approved agent card may have
//    changed the job meanwhile: the Mac then refuses in words and the typed values stay);
//  - a create keeps its first id for the life of the form, so a second press after a lost answer can never make "name-2";
//  - a slow or lost answer ends in words (check Schedules before saving again), and two quick taps send one frame.
import type { ScheduleChangeT, ScheduleDetailT, ScheduleT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider, NotSentError, TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { SlowPatch } from '../../src/lib/socketSchedules.ts'
import { job } from './variants.ts'

afterEach(cleanup)

const row = (over: Partial<ScheduleT> = {}): ScheduleT =>
  job({ id: 'daily-digest', name: 'Daily digest', editable: true, read_only_reason: null, ...over })
const detailOf = (schedule: ScheduleT): ScheduleDetailT => ({
  schedule,
  prompt: 'Summarise.',
  prompt_truncated: false,
  guard: null,
  next_runs: [],
  runs: [],
})

describe('an update carries the revision the form was opened on', () => {
  it('a job changed elsewhere while the form is open: Save is refused in words, nothing is written, the typed values stay', async () => {
    const client = createFakeClient()
    const opened = row()
    const seen: ScheduleChangeT[] = []
    // the Mac refuses a revision that is no longer the job's (here: any base_etag that is not the one it holds now)
    const NOW_ETAG = `sha256:${'b'.repeat(64)}`
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      seen.push(change)
      if (change.op === 'update' && change.base_etag !== NOW_ETAG)
        throw new TalosClientError('schedule_conflict', 'The job changed on your Mac. Reload it and try again.')
      return { clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1', saved: true }
    })
    const ui = (s: ScheduleT) => (
      <ClientProvider client={client}>
        <MemoryRouter>
          <ScheduleForm mode="edit" schedule={s} detail={detailOf(s)} onCancel={() => {}} onDone={() => {}} />
        </MemoryRouter>
      </ClientProvider>
    )
    const view = render(ui(opened))
    // another tab or an approved agent card changes the job: the live row now has a new revision
    view.rerender(ui({ ...opened, etag: NOW_ETAG }))
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Morning digest')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The job changed on your Mac. Reload it and try again.')
    // it sent the revision the form opened on, not the live one
    expect(seen[0]).toMatchObject({ op: 'update', base_etag: opened.etag })
    // and the owner's typed words are still there
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Morning digest')
    expect(screen.queryByTestId('saved-line')).toBeNull()
  })
})

describe('a create keeps its first id, so pressing Save again cannot make a second job', () => {
  function mountCreate() {
    const client = createFakeClient()
    const calls: ScheduleChangeT[] = []
    const answers: Array<() => Promise<{ clientRef: string; saved?: true }>> = []
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      calls.push(change)
      const next = answers.shift()
      return next ? next() : { clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1', saved: true }
    })
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <ScheduleForm mode="create" />
        </MemoryRouter>
      </ClientProvider>,
    )
    return { client, calls, answers }
  }
  const type = async (name = 'Weekly digest') => {
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), name)
    if (!(screen.getByLabelText('What to do') as HTMLTextAreaElement).value)
      await userEvent.type(screen.getByLabelText('What to do'), 'Summarise the week.')
  }
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }))
  const idOf = (c: ScheduleChangeT | undefined) => (c?.op === 'create' ? c.draft.id : undefined)

  it('ack lost, then retry: the slow answer ends in words, and the second press sends the SAME id although the list now has the job', async () => {
    const { client, calls, answers } = mountCreate()
    answers.push(async () => {
      throw new SlowPatch('01JAAAAAAAAAAAAAAAAAAAAAA2')
    })
    await type()
    await save()
    const words = await screen.findByTestId('slow-save')
    expect(words.textContent).toMatch(/may or may not be saved/)
    expect(words.textContent).toMatch(/Check Schedules before you save again/)
    // the first write did land: the refreshed list now holds the job under the first id
    const first = idOf(calls[0]) as string
    const snap = client.store.getState().schedules.snapshot
    client.store.setState((s) => ({
      schedules: {
        ...s.schedules,
        snapshot: snap && { ...snap, schedules: [...snap.schedules, row({ id: first, name: 'Weekly digest' })] },
      },
    }))
    await userEvent.click(screen.getByRole('button', { name: 'Back to the form' }))
    await save()
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(idOf(calls[1])).toBe(first)
    expect(first).toBe('weekly-digest') // never weekly-digest-2
  })

  it('a socket that drops before anything is sent says so in words, keeps the form, and the retry uses the same id', async () => {
    const { calls, answers } = mountCreate()
    answers.push(async () => {
      throw new NotSentError('internal', "You're offline.")
    })
    await type()
    await save()
    expect((await screen.findByRole('alert')).textContent).toBe("You're offline.")
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly digest')
    await save()
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(idOf(calls[1])).toBe(idOf(calls[0]))
  })

  it('a create that finds the job already there (the first Save went through) is refused in plain words, and no second job is asked for', async () => {
    const { calls, answers } = mountCreate()
    answers.push(async () => {
      throw new TalosClientError('schedule_conflict', 'schedule_conflict: id: already exists')
    })
    await type()
    await save()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/already there/)
    expect(alert.textContent).toMatch(/check Schedules before you save again/)
    expect(calls).toHaveLength(1)
  })

  it('a new name is a new job: it gets its own id', async () => {
    const { calls, answers } = mountCreate()
    answers.push(async () => {
      throw new NotSentError('internal', "You're offline.")
    })
    await type('Weekly digest')
    await save()
    await screen.findByRole('alert')
    await type('Monthly report')
    await save()
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(idOf(calls[0])).toBe('weekly-digest')
    expect(idOf(calls[1])).toBe('monthly-report')
  })

  it('two quick taps send one frame', async () => {
    const { calls, answers } = mountCreate()
    let release: () => void = () => {}
    answers.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1', saved: true })
        }),
    )
    await type()
    const button = screen.getByRole('button', { name: 'Save' })
    button.click()
    button.click()
    await waitFor(() => expect(calls).toHaveLength(1))
    release()
    await screen.findByTestId('saved-line')
    expect(calls).toHaveLength(1)
  })
})

describe('the form shows and saves from the same read of the job', () => {
  it('the detail is at revision A and the list row at B: the form shows the detail, Save sends A, is refused, and the typed values stay', async () => {
    const client = createFakeClient()
    const A = `sha256:${'a'.repeat(64)}`
    const B = `sha256:${'b'.repeat(64)}`
    const detailRow = row({ etag: A, name: 'Daily digest' })
    const listRow = row({ etag: B, name: 'Renamed elsewhere' })
    const seen: ScheduleChangeT[] = []
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      seen.push(change)
      throw new TalosClientError('schedule_conflict', 'base_etag is not the revision the card shows; re-read the job')
    })
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <ScheduleForm
            mode="edit"
            schedule={listRow}
            detail={detailOf(detailRow)}
            onCancel={() => {}}
            onDone={() => {}}
          />
        </MemoryRouter>
      </ClientProvider>,
    )
    // what the owner sees is what the detail read gave (revision A), not the newer list row
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Daily digest')
    const prompt = screen.getByLabelText('What to do')
    await userEvent.clear(prompt)
    await userEvent.type(prompt, 'My new words')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The job changed on your Mac. Reload it and try again.')
    expect(seen[0]).toMatchObject({ op: 'update', id: 'daily-digest', base_etag: A })
    expect((screen.getByLabelText('What to do') as HTMLTextAreaElement).value).toBe('My new words')
  })
})
