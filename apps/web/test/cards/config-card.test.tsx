// O1: a settings card (kind:config) in the app: its own label and icon, old and new in the body, no editing, Apply.
import { bindingFrom, Card, configCardCandidate, payloadHash } from '@talos-app/protocol'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { KIND_LABEL } from '../../src/features/cards/logic.ts'
import { renderWith, setup } from './helpers.tsx'

describe('a config card (O1)', () => {
  it('has its own label and icon, shows old and new, cannot be edited, can be revised, and says what the approval does', async () => {
    expect(KIND_LABEL.config).toEqual({ icon: '⚙', label: 'Setting' })
    const card = Card.parse(
      configCardCandidate({
        cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        threadId: 'general',
        now: '2026-11-01T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        origin: 'chat',
        baseRev: 0,
        reason: 'you asked',
        changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
      }),
    )
    card.payload_hash = payloadHash(bindingFrom(card))
    renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
    expect(await screen.findByText('Setting')).toBeTruthy()
    expect(screen.getByText(/Agent name: Talos → Hal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
  })
})
