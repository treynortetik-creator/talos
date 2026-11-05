// WP-I5 / review M6: a push's Approve button arms a card in memory. It never approves by itself, and a URL never arms.
import { screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { armCard, resetArmForTests } from '../../src/features/cards/arm.tsx'
import { CardDeepLink } from '../../src/features/cards/CardDeepLink.tsx'
import { makeCard, renderWith, setup } from './helpers.tsx'

function Search() {
  return <i data-testid="search">{useLocation().search}</i>
}
const sent = (c: { sent: Array<Record<string, unknown>> }) => c.sent.filter((f) => f.type === 'card.resolve')
// The native shell's Approve tap arms the card in memory before the route opens; `q` is only ever a hostile URL.
const PAST_ARM_DELAY_MS = 600
afterEach(resetArmForTests)
const open = (card: ReturnType<typeof makeCard>, client: ReturnType<typeof setup>, q = '', arm = true) => {
  if (arm) armCard(card.id)
  return renderWith(
    <>
      <CardDeepLink />
      <Search />
    </>,
    client,
    `/card/${card.id}${q}`,
    '/card/:id',
  )
}

describe('Approve from a push', () => {
  it('a live high-risk card starts its normal flow: Face ID first, and only then is anything sent', async () => {
    const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish' })
    const client = setup({ cards: [card] })
    const order: string[] = []
    const stepup = client.stepup.bind(client)
    client.stepup = async (p) => {
      order.push('stepup')
      expect(sent(client)).toHaveLength(0)
      return stepup(p)
    }
    open(card, client)
    await waitFor(() => expect(sent(client)).toHaveLength(1))
    expect(order).toEqual(['stepup'])
  })

  it('audit finding: in the iPhone app a push Approve on a high-risk card waits for a real tap (no passkey prompt without a gesture)', async () => {
    const g = globalThis as Record<string, unknown>
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    try {
      const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish' })
      const client = setup({ cards: [card] })
      const stepup = vi.spyOn(client, 'stepup')
      open(card, client)
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Publish/ })))
      await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
      expect(stepup).not.toHaveBeenCalled()
      expect(sent(client)).toHaveLength(0)
    } finally {
      delete g.Capacitor
    }
  })

  it('a cancelled Face ID sends nothing and says so', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    client.stepup = async () => {
      throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
    }
    open(card, client)
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/i)
    expect(sent(client)).toHaveLength(0)
  })

  it('a low-risk card is NOT approved by the link: it is shown with Send focused, nothing sent', async () => {
    const card = makeCard({ risk: 'low' })
    const client = setup({ cards: [card] })
    const resolve = vi.spyOn(client, 'resolveCard')
    open(card, client)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Send/ })))
    expect(resolve).not.toHaveBeenCalled()
    expect(sent(client)).toHaveLength(0)
  })

  it('an Open tap (no arm) never starts anything, even on a high-risk card', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    open(card, client, '', false)
    await screen.findByRole('button', { name: /Send/ })
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).not.toHaveBeenCalled()
  })

  it.each(['?arm=primary', '?arm=secondary', '?arm=', '?arm=primary,kill', '?arm=PRIMARY', '?armed=primary'])(
    'a URL never arms (%s): a link in agent text cannot start an approval prompt',
    async (q) => {
      const card = makeCard({ risk: 'high' })
      const client = setup({ cards: [card] })
      const stepup = vi.spyOn(client, 'stepup')
      open(card, client, q, false)
      await screen.findByRole('button', { name: /Send/ })
      await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
      expect(stepup).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['expired', { state: 'expired' }],
    [
      'already decided',
      {
        state: 'resolved',
        resolution: { action: 'kill', at: '2026-10-28T08:41:00.000Z', edited: false, payload_hash: 'sha256:x' },
      },
    ],
    ['past its expiry time', { expires_at: '2020-01-01T00:00:00.000Z' }],
  ])('a stale card (%s) ignores it', async (_n, over) => {
    const card = makeCard({ risk: 'high', ...over })
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    open(card, client)
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).not.toHaveBeenCalled()
    expect(sent(client)).toHaveLength(0)
  })

  it('an altered card ignores it', async () => {
    const original = makeCard({ risk: 'high' })
    const card = { ...original, body: 'Send the money somewhere else.' }
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    open(card, client)
    await screen.findByRole('alert')
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).not.toHaveBeenCalled()
  })

  it('the arm is spent: a re-render, or a second card view for the same card, does not run it twice', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    open(card, client)
    await waitFor(() => expect(sent(client)).toHaveLength(1))
    expect(screen.getByTestId('location').textContent).toBe(`/card/${card.id}`)
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).toHaveBeenCalledTimes(1)
  })

  it('a card that is gone shows the plain notice and runs nothing', async () => {
    const client = setup()
    const stepup = vi.spyOn(client, 'stepup')
    armCard('c_01JBF3V7Q8K2M4N6P8R0S2T4ZZ')
    renderWith(<CardDeepLink />, client, '/card/c_01JBF3V7Q8K2M4N6P8R0S2T4ZZ', '/card/:id')
    expect(screen.getByText(/no longer here/)).toBeTruthy()
    expect(stepup).not.toHaveBeenCalled()
  })
})

describe('the arm belongs to one card', () => {
  it('moving on to another card does not carry it over', async () => {
    const a = makeCard({ risk: 'high' })
    const b = makeCard({ risk: 'high' })
    armCard(a.id)
    const client = setup({ cards: [a, b] })
    const stepup = vi.spyOn(client, 'stepup')
    renderWith(<CardDeepLink />, client, `/card/${b.id}`, '/card/:id')
    await screen.findByRole('button', { name: /Send/ })
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).not.toHaveBeenCalled()
  })

  it('a spent arm stays spent: a second view of the same card later is not armed', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    // A cancelled Face ID leaves the card live and pending, so only the spent arm stops a second run.
    const stepup = vi.fn(async () => {
      throw new Error('cancelled')
    })
    client.stepup = stepup
    const first = open(card, client)
    await waitFor(() => expect(stepup).toHaveBeenCalledTimes(1))
    first.unmount()
    renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).toHaveBeenCalledTimes(1)
  })

  it('an arm older than two minutes lapses', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    const stepup = vi.spyOn(client, 'stepup')
    armCard(card.id, Date.now() - 121_000)
    open(card, client, '', false)
    await screen.findByRole('button', { name: /Send/ })
    await new Promise((r) => setTimeout(r, PAST_ARM_DELAY_MS))
    expect(stepup).not.toHaveBeenCalled()
  })
})
