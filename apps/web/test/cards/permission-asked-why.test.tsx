// One line on a permission card saying why it asked (Wave 0, 0.9). Drawn only when the bridge sent a reason it could prove
// (`asked_why`); a card with no reason, or one this app does not know, shows no line at all.
import { Card, composePermissionCard, PERMISSION_ASKED_WHY_TEXT } from '@talos-app/protocol'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const make = (askedWhy?: 'your_rule') =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Push the branch',
      input_preview: '{"command": "git push origin main"}',
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4G0',
    thread_id: 'general',
    now: Date.parse('2026-10-28T15:00:00.000Z'),
    client_version: '2.1.312',
    ...(askedWhy ? { asked_why: askedWhy } : {}),
  })

let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
})
afterEach(() => restoreIO())

describe('the "why it asked" line', () => {
  it('your_rule: one plain line on the card, and the same line on the full-screen sheet', async () => {
    const c = make('your_rule')
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByTestId('permission-asked-why').textContent).toBe(PERMISSION_ASKED_WHY_TEXT.your_rule)
    await userEvent.click(screen.getByTestId('permission-open'))
    const sheet = screen.getByTestId('approval-sheet')
    expect(within(sheet).getByTestId('permission-asked-why').textContent).toBe(PERMISSION_ASKED_WHY_TEXT.your_rule)
  })

  it('no reason known: no line on the card or on the sheet', async () => {
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByTestId('permission-asked-why')).toBeNull()
    await userEvent.click(screen.getByTestId('permission-open'))
    expect(screen.queryByTestId('permission-asked-why')).toBeNull()
  })

  it('a reason this app does not know reads as none: no line', () => {
    const c = Card.parse({ ...make(), asked_why: 'safety_check' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByTestId('permission-asked-why')).toBeNull()
  })

  it('the line is only a note: Allow and Deny work as before', () => {
    const c = make('your_rule')
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
