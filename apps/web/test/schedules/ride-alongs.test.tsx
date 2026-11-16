// Three small schedules findings from the bug hunt (docs/audits/2026-11-10-bughunt-web.md, "smaller notes"): a heartbeat run
// with a date-only key shown as a clock time, fix steps found in any number before a ". ", and a catch-up check that kept a
// hand-written job from being renamed.
import type { ScheduleChangeT, ScheduleDetailT, ScheduleT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixParts, runTimeToday } from '../../src/features/schedules/logic.ts'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { job } from './variants.ts'

afterEach(cleanup)

describe("the time of one of today's heartbeat runs", () => {
  const time = (iso: string) => `at ${iso.slice(11, 16)}`
  it('a date-only key is "today", never its "10-28" passed off as a clock time', () => {
    expect(runTimeToday({ ds: '2026-10-28' }, time)).toBe('today')
  })
  it("a slot key gives the slot's time, and a run that started gives when it started", () => {
    expect(runTimeToday({ ds: '2026-10-28T0945' }, time)).toBe('09:45')
    expect(runTimeToday({ ds: '2026-10-28', started_at: '2026-10-28T09:46:10Z' }, time)).toBe('at 09:46')
  })
})

describe('fix steps', () => {
  it('only a 1, 2, 3… run of numbers is steps: a number in the text before a ". " is not', () => {
    expect(fixParts('Wait 10. Then retry at 3. It usually clears.')).toEqual({
      intro: null,
      steps: ['Wait 10. Then retry at 3. It usually clears.'],
    })
    expect(
      fixParts('The tick stopped. 1. Check the Mac is awake. 2. Run chronos doctor (needs 2. 0 or later).'),
    ).toEqual({
      intro: 'The tick stopped.',
      steps: ['Check the Mac is awake.', 'Run chronos doctor (needs 2. 0 or later).'],
    })
  })
  it('steps on their own lines still split', () => {
    expect(fixParts('1. Do a.\n2. Do b.').steps).toEqual(['Do a.', 'Do b.'])
  })
})

describe('renaming a job whose catch-up is under 15 minutes', () => {
  function mountEdit(catchupMin: number) {
    const schedule: ScheduleT = job({
      id: 'hand-written',
      name: 'Hand written',
      catchup_min: catchupMin,
      editable: true,
      read_only_reason: null,
    })
    const detail: ScheduleDetailT = {
      schedule,
      prompt: 'Do it.',
      prompt_truncated: false,
      guard: null,
      next_runs: [],
      runs: [],
    }
    const client = createFakeClient()
    const calls: ScheduleChangeT[] = []
    vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
      calls.push(change)
      return { clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1' }
    })
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <ScheduleForm mode="edit" schedule={schedule} detail={detail} onCancel={() => {}} onDone={() => {}} />
        </MemoryRouter>
      </ClientProvider>,
    )
    return calls
  }
  const submit = () => screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ })

  it('goes through: an untouched catch-up is not re-judged', async () => {
    const calls = mountEdit(5)
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed')
    await userEvent.click(submit())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ op: 'update', id: 'hand-written', set: { name: 'Renamed' } })
  })

  it('a catch-up the owner changes is still checked', async () => {
    const calls = mountEdit(30)
    const field = screen.getByDisplayValue('30')
    await userEvent.clear(field)
    await userEvent.type(field, '5')
    await userEvent.click(submit())
    expect(await screen.findByText('Between 15 and 1440 minutes.')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})
