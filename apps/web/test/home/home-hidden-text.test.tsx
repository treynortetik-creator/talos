// Home lists a card by its title and one line under it. Both come from the agent or an email, so a direction override or an
// invisible character must show as a visible token there, the same as on the card itself.
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HomeScreen } from '../../src/features/home/HomeScreen.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

const RLO = '\u202E'
const ZWSP = '\u200B'

const shown = () => document.body.textContent ?? ''

describe('Home shows hidden characters in a card row as tokens', () => {
  it('in the title', () => {
    const card = makeCard({ title: `Pay${RLO}bob` })
    renderWith(<HomeScreen />, setup({ cards: [card] }))
    expect(shown()).not.toContain(RLO)
    expect(shown()).toContain('Pay⟦U+202E⟧bob')
  })

  it('in the line under a waiting card: its summary, or its first destination when there is none', () => {
    const withSummary = makeCard({ title: 'Has summary', summary: `Send${ZWSP}it` })
    const withDestination = makeCard({
      title: 'Has destination',
      summary: undefined,
      destination: [{ label: 'To', value: `bank${RLO}.com` }],
    })
    renderWith(<HomeScreen />, setup({ cards: [withSummary, withDestination] }))
    expect(shown()).not.toContain(ZWSP)
    expect(shown()).not.toContain(RLO)
    expect(shown()).toContain('Send⟦U+200B⟧it')
    expect(shown()).toContain('bank⟦U+202E⟧.com')
  })

  it('in the line under a card that has an answer', () => {
    const card = makeCard({
      title: 'Answered',
      state: 'done',
      resolution: { action: 'primary', at: '2026-10-28T15:00:00.000Z', edited: false, payload_hash: 'sha256:x' },
      result: { ok: true, text: `Sent${ZWSP}ok`, at: '2026-10-28T15:01:00.000Z' },
    })
    renderWith(<HomeScreen />, setup({ cards: [card] }))
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(shown()).not.toContain(ZWSP)
    expect(shown()).toContain('Sent⟦U+200B⟧ok')
  })
})
