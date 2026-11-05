// The card kinds on the wire: which exist, in what order, and who may mint each.
import { describe, expect, it } from 'vitest'
import { AGENT_CARD_KINDS, BRIDGE_ONLY_CARD_KINDS, Card, isAgentCardKind } from '../src/index.ts'

describe('card kinds', () => {
  it('lists the agent kinds in order', () => {
    expect([...AGENT_CARD_KINDS]).toEqual(['email', 'message', 'deploy', 'publish', 'purchase', 'decision', 'generic'])
  })

  it('lists the bridge-only kinds in order', () => {
    expect([...BRIDGE_ONLY_CARD_KINDS]).toEqual(['schedule', 'permission', 'app_action', 'config'])
  })

  it('accepts exactly these kinds on a Card, in this order', () => {
    expect([...Card.shape.kind.options]).toEqual([
      'email',
      'message',
      'deploy',
      'publish',
      'purchase',
      'decision',
      'generic',
      'schedule',
      'permission',
      'app_action',
      'config',
    ])
  })

  it('lets the agent mint only the agent kinds', () => {
    for (const k of AGENT_CARD_KINDS) expect(isAgentCardKind(k)).toBe(true)
    for (const k of BRIDGE_ONLY_CARD_KINDS) expect(isAgentCardKind(k)).toBe(false)
    expect(isAgentCardKind('nope')).toBe(false)
    expect(isAgentCardKind(undefined)).toBe(false)
  })
})
