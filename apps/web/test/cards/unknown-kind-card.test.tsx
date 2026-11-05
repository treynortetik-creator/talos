// A card whose kind this build does not know still draws, as a generic card. A newer peer's card never gets here:
// strict parsing drops it at the socket (socketClient.ts, parseFrame). The one path that can reach the fallback is a
// cached snapshot (pickSnapshot), for example a device rolled back to an older build that reads the cache a newer
// build wrote. The fake client has no snapshot loader, so these tests put the card straight into the store.
import { bindingFrom, type CardT, payloadHash } from '@talos-app/protocol'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardView } from '../../src/features/cards/CardView.tsx'
import { makeCard, renderWith, setup } from './helpers.tsx'

const at = '2026-11-01T10:05:00.000Z'
const res = { action: 'primary', at } as const

/** A card of `kind`, hashed over that same kind so it is not drawn as altered. */
function cardOfKind(kind: string, over: Record<string, unknown> = {}): CardT {
  const base = { ...makeCard(), ...over, kind } as unknown as CardT
  base.payload_hash = payloadHash(bindingFrom(base))
  return base
}

function draw(card: CardT) {
  const { container } = renderWith(<CardView card={card} threadName="General" />, setup({ cards: [card] }))
  return container
}

describe.each(['from_a_newer_build', 'constructor', 'toString', '__proto__'])('a card of unknown kind %s', (kind) => {
  it('draws a pending card with the generic label, not as altered', async () => {
    const c = draw(cardOfKind(kind))
    expect(await screen.findByText(/Card · General/)).toBeTruthy()
    expect(screen.queryByText(/altered/i)).toBeNull()
    expect(c.textContent).not.toMatch(/undefined|function|\[object/)
  })

  it('says "Done" after it was approved and ran', () => {
    const c = draw(cardOfKind(kind, { state: 'done', resolution: res, result: { ok: true, text: 'ok', at } }))
    expect(c.textContent).toContain('Done')
    expect(c.textContent).not.toMatch(/undefined|function|\[object/)
  })

  it('says "Couldn\'t finish" when it failed', () => {
    const c = draw(cardOfKind(kind, { state: 'failed' }))
    expect(c.textContent).toContain("Couldn't finish")
    expect(c.textContent).not.toMatch(/undefined|function|\[object/)
  })

  it('says "Couldn\'t finish" when it ran and the result was not ok', () => {
    const c = draw(cardOfKind(kind, { state: 'done', resolution: res, result: { ok: false, text: 'bounced', at } }))
    expect(c.textContent).toContain("Couldn't finish")
    expect(c.textContent).not.toMatch(/undefined|function|\[object/)
  })
})
