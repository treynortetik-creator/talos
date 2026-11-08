// Job memory on the schedule form: a checkbox, off by default, on create and on edit. It goes in the proposal only when it is
// on (create) or when the owner changed it (edit), like every other field; the scheduler never sees it.
import type { ScheduleChangeT, ScheduleDetailT, ScheduleT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankForm, draftFromForm, formFromSchedule, touchedSet } from '../../src/features/schedules/logic.ts'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { job } from './variants.ts'

afterEach(cleanup)

const submitButton = () => screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ })

function mount(memory?: boolean, over: Partial<ScheduleT> = {}) {
  const client = createFakeClient()
  const calls: ScheduleChangeT[] = []
  vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
    calls.push(change)
    return { clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1' }
  })
  if (memory === undefined) {
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <ScheduleForm mode="create" />
        </MemoryRouter>
      </ClientProvider>,
    )
    return calls
  }
  const schedule: ScheduleT = job({
    id: 'weekly-cleanup',
    name: 'Weekly cleanup',
    editable: true,
    read_only_reason: null,
    ...(memory ? { memory: true } : {}),
    ...over,
  })
  const detail: ScheduleDetailT = {
    schedule,
    prompt: 'Tidy up.',
    prompt_truncated: false,
    guard: null,
    next_runs: [],
    runs: [],
  }
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <ScheduleForm mode="edit" schedule={schedule} detail={detail} onCancel={() => {}} onDone={() => {}} />
      </MemoryRouter>
    </ClientProvider>,
  )
  return calls
}

describe('the form logic', () => {
  it('memory is off in a blank form, and a draft from it does not carry the field at all', () => {
    const f = blankForm(null)
    expect(f.memory).toBe(false)
    const d = draftFromForm({ ...f, name: 'X job', prompt: 'Do it.' }, 'x-job')
    expect(d && 'memory' in d).toBe(false)
  })

  it('a form with memory on makes a draft with memory:true', () => {
    const d = draftFromForm({ ...blankForm(null), name: 'X job', prompt: 'Do it.', memory: true }, 'x-job')
    expect(d?.memory).toBe(true)
  })

  it('an old job (no field) opens as off; one with memory on opens as on', () => {
    expect(formFromSchedule(job({ id: 'x-job' }), 'p').memory).toBe(false)
    expect(formFromSchedule(job({ id: 'x-job', memory: true }), 'p').memory).toBe(true)
  })

  it('an edit sends memory only when the owner changed it, in either direction', () => {
    const off = formFromSchedule(job({ id: 'x-job' }), 'p')
    expect(touchedSet(off, { ...off, memory: true })).toEqual({ memory: true })
    expect(touchedSet(off, { ...off, name: 'New' })).toEqual({ name: 'New' })
    const on = formFromSchedule(job({ id: 'x-job', memory: true }), 'p')
    expect(touchedSet(on, { ...on, memory: false })).toEqual({ memory: false })
  })
})

describe('the form', () => {
  it('create: the box is off by default and the proposal has no memory field', async () => {
    const calls = mount()
    const box = screen.getByRole('checkbox', { name: /Remember between runs/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.type(screen.getByLabelText('Name'), 'Weekly digest')
    await userEvent.type(screen.getByLabelText('What to do'), 'Summarise the week.')
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.op === 'create' && 'memory' in calls[0].draft).toBe(false)
  })

  it('create: ticking the box sends memory:true, and the box says what is kept', async () => {
    const calls = mount()
    const box = screen.getByRole('checkbox', { name: /Remember between runs/ })
    expect(box.closest('label, div')?.textContent).toMatch(/last 3 results/)
    expect(box.closest('label, div')?.textContent).toMatch(/2 KB/)
    await userEvent.click(box)
    await userEvent.type(screen.getByLabelText('Name'), 'Weekly digest')
    await userEvent.type(screen.getByLabelText('What to do'), 'Summarise the week.')
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ op: 'create', draft: { memory: true } })
  })

  it('edit: a job with memory off shows the box off; ticking it sends only memory:true', async () => {
    const calls = mount(false)
    const box = screen.getByRole('checkbox', { name: /Remember between runs/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ op: 'update', id: 'weekly-cleanup', set: { memory: true } })
    expect(Object.keys((calls[0] as { set: object }).set)).toEqual(['memory'])
  })

  it('edit: a job with memory on shows the box on; clearing it sends memory:false, and a rename alone does not mention it', async () => {
    const calls = mount(true)
    const box = screen.getByRole('checkbox', { name: /Remember between runs/ }) as HTMLInputElement
    expect(box.checked).toBe(true)
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Weekly tidy')
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.stringify(calls[0])).not.toContain('memory')
    cleanup()
    const calls2 = mount(true)
    await userEvent.click(screen.getByRole('checkbox', { name: /Remember between runs/ }))
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls2).toHaveLength(1))
    expect(calls2[0]).toMatchObject({ set: { memory: false } })
  })
})

describe('the box is honest about who gets memory', () => {
  const note = /does not get this yet/
  const hint = () => screen.getByRole('checkbox', { name: /Remember between runs/ }).closest('label')?.textContent ?? ''

  it('a job that runs in the session says nothing of the kind', () => {
    mount(false)
    expect(hint()).not.toMatch(note)
  })

  it('a background job says memory does not reach it yet', () => {
    mount(false, { runner: 'headless' })
    expect(hint()).toMatch(note)
  })

  it('a restricted job, which always runs in the background whatever its runner says, says it too', () => {
    mount(false, { runner: 'session', permissions: 'restricted', allowed_tools: ['Read'] })
    expect(hint()).toMatch(note)
  })

  it('on create, choosing the background runner or the tool list changes the note', async () => {
    mount()
    expect(hint()).not.toMatch(note)
    await userEvent.click(screen.getByRole('radio', { name: 'Only the tools I list' }))
    expect(hint()).toMatch(note)
    await userEvent.click(screen.getByRole('radio', { name: 'Full permissions' }))
    expect(hint()).not.toMatch(note)
  })
})
