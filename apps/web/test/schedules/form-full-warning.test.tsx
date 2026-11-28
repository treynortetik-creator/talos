// The schedule form says what full permissions mean, in the card's own words (one shared constant), as a plain line that
// never blocks Save: it comes and goes with the permission choice, and a job without full permissions never shows it.
import { SCHEDULE_FULL_WARNING } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { ScheduleForm } from '../../src/features/schedules/ScheduleForm.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

afterEach(cleanup)

function mount() {
  render(
    <ClientProvider client={createFakeClient()}>
      <MemoryRouter>
        <ScheduleForm mode="create" />
      </MemoryRouter>
    </ClientProvider>,
  )
}

describe('the full-permissions line in the schedule form', () => {
  it("is the card's own wording, shown for full permissions, and Save is not blocked", () => {
    mount()
    expect(screen.getByText(SCHEDULE_FULL_WARNING)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('goes when the owner picks only listed tools, and comes back with full permissions', async () => {
    mount()
    await userEvent.click(screen.getByRole('radio', { name: 'Only the tools I list' }))
    expect(screen.queryByText(SCHEDULE_FULL_WARNING)).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'Full permissions' }))
    expect(screen.getByText(SCHEDULE_FULL_WARNING)).toBeTruthy()
  })
})

describe('spacing', () => {
  it('the permissions block leaves room under the line, like the other blocks, so Tell me is not flush against it', () => {
    mount()
    const block = screen.getByText(SCHEDULE_FULL_WARNING).closest('fieldset')
    expect(block?.className).toContain('pb-4')
  })
})
