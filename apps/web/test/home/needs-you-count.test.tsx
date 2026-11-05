// The "Needs you" badge, the Home tab and the thread's "N needs you" pill all count the same cards: an expired card
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

  it('the thread pill ignores an expired card', () => {
    renderWith(<ThreadScreen />, setup({ cards: [expired()] }), '/t/general', '/t/:thread')
    expect(screen.queryByText(/needs you$/)).toBeNull()
  })
})
