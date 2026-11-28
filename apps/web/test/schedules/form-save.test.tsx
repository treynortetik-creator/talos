// Save in the schedule form: on a current Mac the owner's own Save applies at once and no card exists at all (nothing to approve,
// nothing that could flash an Approve button): "Sending your change…", then "Saved.". An older Mac still draws the card, and then
// the old sentence is the true one. The delete, adopt and Turn on sheets never ask for the direct save.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

async function fillAndSave(savesInForm: boolean, hold?: Promise<void>) {
  const client = createFakeClient()
  client.schedules.setSavesInForm(savesInForm)
  const real = client.schedules.proposeScheduleChange.bind(client.schedules)
  const propose = vi.spyOn(client.schedules, 'proposeScheduleChange').mockImplementation(async (c, t, o) => {
    await hold
    return real(c, t, o)
  })
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <ScheduleForm mode="create" />
      </MemoryRouter>
    </ClientProvider>,
  )
  await userEvent.type(screen.getByLabelText('Name'), 'Weekly digest')
  await userEvent.type(screen.getByLabelText('What to do'), 'Summarise the week.')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(propose).toHaveBeenCalledTimes(1))
  return { client, propose }
}

describe('Save in the schedule form', () => {
  it('asks for the direct save; on a current Mac it says Sending your change, then Saved, and no card is ever made', async () => {
    let release: () => void = () => {}
    const { client, propose } = await fillAndSave(true, new Promise<void>((r) => (release = r)))
    expect(propose.mock.calls[0]?.[2]).toEqual({ formSave: true })
    expect((await screen.findByText('Sending your change…')).getAttribute('role')).toBe('status')
    expect(client.store.getState().cards.filter((c) => c.kind === 'schedule')).toHaveLength(0)
    release()
    expect((await screen.findByTestId('saved-line')).textContent).toBe('Saved.')
    expect(screen.queryByText('Sending your change…')).toBeNull()
    expect(screen.queryByText(/Nothing is written until you approve/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save change' })).toBeNull()
    expect(client.store.getState().cards.filter((c) => c.kind === 'schedule')).toHaveLength(0)
    expect(client.sent.find((f) => f.type === 'schedule.patch')).toMatchObject({ form_save: true })
  })

  it('on an older Mac the card still waits for a tap, and the screen says so', async () => {
    const { client } = await fillAndSave(false)
    await waitFor(() => expect(client.store.getState().cards.at(-1)?.state).toBe('pending'))
    expect(await screen.findByText(/Nothing is written until you approve/)).toBeTruthy()
    expect(screen.queryByTestId('saved-line')).toBeNull()
  })
})
