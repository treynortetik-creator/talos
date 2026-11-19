// The "Needs you" badge, the Home tab and the chip in the thread's header all count the same cards: an expired card
// ("Expired, nothing ran") or one that fails its hash check never asks for the owner.
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { awaitsOwner } from '../../src/features/cards/logic.ts'
import { BottomBar } from '../../src/features/threads/Nav.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

const live = () => makeCard({ title: 'Live' })
const expired = () => makeCard({ title: 'Expired', expires_at: '2020-01-01T00:00:00.000Z' })
const altered = () => makeCard({ title: 'Altered', payload_hash: `sha256:${'1'.repeat(64)}` })

describe('needs-you count', () => {
  it('awaitsOwner: pending, unexpired and verifiable only', () => {
    const now = Date.now()
    expect(awaitsOwner(live(), now)).toBe(true)
    expect(awaitsOwner(expired(), now)).toBe(false)
    expect(awaitsOwner(altered(), now)).toBe(false)
  })

  it('the bottom-bar badge ignores expired and altered cards', () => {
    renderWith(<BottomBar />, setup({ cards: [live(), expired(), altered()] }))
    expect(screen.getByRole('img', { name: '1 need you' })).toBeTruthy()
  })

  it('no badge when the only pending card has expired', () => {
    renderWith(<BottomBar />, setup({ cards: [expired()] }))
    expect(screen.queryByRole('img', { name: /need you/ })).toBeNull()
  })

  it('the thread chip ignores an expired card', () => {
    renderWith(<ThreadScreen />, setup({ cards: [expired()] }), '/t/general', '/t/:thread')
    expect(screen.queryByTestId('needs-you-chip')).toBeNull()
  })

  it('the thread chip counts the same cards as the badge, and takes no row above the composer', () => {
    renderWith(<ThreadScreen />, setup({ cards: [live(), expired(), altered()] }), '/t/general', '/t/:thread')
    const chip = screen.getByTestId('needs-you-chip')
    expect(chip.textContent).toBe('1')
    expect(chip.getAttribute('aria-label')).toBe('1 needs you, show the first')
    expect(chip.closest('header')).toBeTruthy()
    expect(screen.queryByText(/needs you$/)).toBeNull()
  })
})
