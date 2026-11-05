// Editing a job that is already on the Mac must not re-judge a tool list the owner did not touch (review finding):
// Chronos accepts Read(~/notes/**) and an empty list on a restricted job, so a rename has to get through.
import type { ScheduleChangeT, ScheduleDetailT, ScheduleT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { job } from './variants.ts'

afterEach(cleanup)

function mountEdit(tools: string[]) {
  const schedule: ScheduleT = job({
    id: 'weekly-cleanup',
    name: 'Weekly cleanup',
    runner: 'headless',
    permissions: 'restricted',
    allowed_tools: tools,
    editable: true,
    read_only_reason: null,
  })
  const detail: ScheduleDetailT = {
    schedule,
    prompt: 'Tidy up.',
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

const submitButton = () => screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ })

async function rename() {
  const name = screen.getByLabelText('Name')
  await userEvent.clear(name)
  await userEvent.type(name, 'Weekly tidy')
  await userEvent.click(submitButton())
}

describe('ScheduleForm edit keeps the tools it was opened with', () => {
  it.each([
    ['a pattern with ~ and **', ['Read(~/notes/**)']],
    ['a Bash prefix with ~ and :*', ['Bash(python3 ~/x.py:*)']],
    ['an empty list (Chronos reads it as the default list)', [] as string[]],
  ])('a rename goes through with %s', async (_label, tools) => {
    const calls = mountEdit(tools)
    await rename()
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ op: 'update', id: 'weekly-cleanup', set: { name: 'Weekly tidy' } })
    expect(JSON.stringify(calls[0])).not.toContain('allowed_tools')
  })

  it('a list the owner edits is still checked, by the rule Chronos uses', async () => {
    const calls = mountEdit(['Read'])
    const box = screen.getByLabelText('Allowed tools')
    await userEvent.clear(box)
    await userEvent.type(box, 'rm -rf "/"')
    await userEvent.click(submitButton())
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/starts with a letter/)
    expect(calls).toHaveLength(0)
  })

  it('a touched list may use the patterns Chronos accepts', async () => {
    const calls = mountEdit(['Read'])
    const box = screen.getByLabelText('Allowed tools')
    await userEvent.clear(box)
    await userEvent.type(box, 'Read(~/notes/**)')
    await userEvent.click(submitButton())
    await waitFor(() => expect(calls).toHaveLength(1))
  })
})
