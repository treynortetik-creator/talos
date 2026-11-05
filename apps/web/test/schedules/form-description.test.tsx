// The schedule form gets the description field the data model already carried (U3), and its "Read-only" permission now
// says what it does (M14); the pause switch announces what on means (M13); "Tell me" says what it governs (M12).
import type { ScheduleChangeT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { SchedulesScreen } from '../../src/features/schedules/SchedulesScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { snapshots } from './captured.ts'

afterEach(cleanup)

function mount() {
  const client = createFakeClient()
  const calls: ScheduleChangeT[] = []
  vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (change) => {
    calls.push(change)
    return { clientRef: '01JAAAAAAAAAAAAAAAAAAAAAA1' }
  })
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <ScheduleForm mode="create" />
      </MemoryRouter>
    </ClientProvider>,
  )
  return calls
}

describe('ScheduleForm', () => {
  it('sends the description the owner typed in the proposal, capped at what the app edits', async () => {
    const calls = mount()
    await userEvent.type(screen.getByLabelText('Name'), 'Weekly digest')
    const d = screen.getByLabelText('Description') as HTMLTextAreaElement
    expect(d.maxLength).toBe(300)
    await userEvent.type(d, 'Summarise the week for Friday.')
    await userEvent.type(screen.getByLabelText('What to do'), 'Summarise the week.')
    await userEvent.click(screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ op: 'create', draft: { description: 'Summarise the week for Friday.' } })
  })

  it('M14: Read-only is now "Only the tools I list", needs a real tool name, and warns that Bash or Edit can change things', async () => {
    const calls = mount()
    expect(screen.queryByText('Read-only')).toBeNull()
    await userEvent.type(screen.getByLabelText('Name'), 'Tools')
    await userEvent.type(screen.getByLabelText('What to do'), 'Look around.')
    await userEvent.click(screen.getByRole('radio', { name: 'Only the tools I list' }))
    expect(screen.getByLabelText('Allowed tools').closest('div')?.textContent).toMatch(/Bash or Edit can change things/)
    await userEvent.click(screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ }))
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/List at least one tool/)
    await userEvent.type(screen.getByLabelText('Allowed tools'), 'rm -rf "/"')
    await userEvent.click(screen.getByRole('button', { name: /Review|Propose|Ask|Send|Save|Create/ }))
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/starts with a letter/)
    expect(calls).toHaveLength(0)
  })

  it('M12: Tell me says it only governs the outside notification; failures always show in the app', () => {
    mount()
    expect(screen.getByText(/only decides whether Chronos sends its own outside notification/)).toBeTruthy()
  })
})

describe('SchedulesScreen rows', () => {
  it('M13: the pause switch is named for what on means (it runs), not "Pause X"', () => {
    const client = createFakeClient()
    const snap = snapshots('02-list-three-jobs')[0]
    if (!snap) throw new Error('capture missing')
    client.store.setState((s) => ({ ...s, schedules: { ...s.schedules, snapshot: snap, status: 'ready' } }))
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <SchedulesScreen />
        </MemoryRouter>
      </ClientProvider>,
    )
    const first = snap.schedules.find((s) => s.enabled)
    expect(screen.getByRole('switch', { name: `${first?.name} runs on schedule` })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: /^Pause / })).toBeNull()
  })
})
