// WP-I5 / review M6: a push's Approve button arms a card in memory. It never approves by itself, and a URL never arms.
import { act, screen, waitFor } from '@testing-library/react'
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
const PAST_ARM_DELAY_MS = 600 // longer than CardView's 350 ms arm delay
// The arm delay runs on a fake clock, so each "nothing happens after the delay" check jumps past it instead of sleeping.
// Only setTimeout and Date are faked: Testing Library's waitFor/findBy need a real timer, so a faked test queries directly.
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
const pastArmDelay = () =>
  act(async () => {
    vi.advanceTimersByTime(PAST_ARM_DELAY_MS)
  })
afterEach(() => {
  vi.useRealTimers()
  resetArmForTests()
})
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
  // No passkey any more (owner ruling 2026-11-14): the primary flow has no second step, so the arm never starts it. It only
  // puts focus on the button, in a browser and in the iPhone app alike, and nothing is sent until the owner taps.
  it('a live high-risk card is NOT approved by the link: Publish gets focus, nothing sent', async () => {
    const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish' })
    const client = setup({ cards: [card] })
    const resolve = vi.spyOn(client, 'resolveCard')
    fakeClock()
    open(card, client)
    await pastArmDelay()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Publish' }))
    expect(resolve).not.toHaveBeenCalled()
    expect(sent(client)).toHaveLength(0)
  })

  it('in the iPhone app the same: a high-risk card waits for a real tap', async () => {
    const g = globalThis as Record<string, unknown>
    g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
    try {
      const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish' })
      const client = setup({ cards: [card] })
      fakeClock()
      open(card, client)
      await pastArmDelay()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Publish' }))
      expect(sent(client)).toHaveLength(0)
    } finally {
      delete g.Capacitor
    }
  })

  it('the tap after the focus is what sends it', async () => {
    const card = makeCard({ risk: 'high', kind: 'publish', primary_label: 'Publish' })
    const client = setup({ cards: [card] })
    open(card, client)
    const button = screen.getByRole('button', { name: 'Publish' })
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(sent(client)).toHaveLength(0)
    button.click()
    await waitFor(() => expect(sent(client)).toHaveLength(1))
    expect(sent(client)[0]?.action).toBe('primary')
  })

  it('a low-risk card is NOT approved by the link: it is shown with Send focused, nothing sent', async () => {
    const card = makeCard({ risk: 'low' })
    const client = setup({ cards: [card] })
    const resolve = vi.spyOn(client, 'resolveCard')
    fakeClock()
    open(card, client)
    await pastArmDelay()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Send/ }))
    expect(resolve).not.toHaveBeenCalled()
    expect(sent(client)).toHaveLength(0)
  })

  it('an Open tap (no arm) never starts anything, even on a high-risk card', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    fakeClock()
    open(card, client, '', false)
    const button = screen.getByRole('button', { name: /Send/ })
    await pastArmDelay()
    expect(document.activeElement).not.toBe(button)
    expect(sent(client)).toHaveLength(0)
  })

  it.each(['?arm=primary', '?arm=secondary', '?arm=', '?arm=primary,kill', '?arm=PRIMARY', '?armed=primary'])(
    'a URL never arms (%s): a link in agent text cannot start an approval',
    async (q) => {
      const card = makeCard({ risk: 'high' })
      const client = setup({ cards: [card] })
      fakeClock()
      open(card, client, q, false)
      const button = screen.getByRole('button', { name: /Send/ })
      await pastArmDelay()
      expect(document.activeElement).not.toBe(button)
      expect(sent(client)).toHaveLength(0)
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
    fakeClock()
    open(card, client)
    await pastArmDelay()
    expect(sent(client)).toHaveLength(0)
  })

  it('an altered card ignores it', async () => {
    const original = makeCard({ risk: 'high' })
    const card = { ...original, body: 'Send the money somewhere else.' }
    const client = setup({ cards: [card] })
    fakeClock()
    open(card, client)
    screen.getByRole('alert')
    await pastArmDelay()
    expect(sent(client)).toHaveLength(0)
  })

  it('a card that is gone shows the plain notice and runs nothing', async () => {
    const client = setup()
    armCard('c_01JBF3V7Q8K2M4N6P8R0S2T4ZZ')
    renderWith(<CardDeepLink />, client, '/card/c_01JBF3V7Q8K2M4N6P8R0S2T4ZZ', '/card/:id')
    expect(screen.getByText(/no longer here/)).toBeTruthy()
    expect(sent(client)).toHaveLength(0)
  })

  it('the URL keeps no arm', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    fakeClock()
    open(card, client)
    await pastArmDelay()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Send/ }))
    expect(screen.getByTestId('search').textContent).toBe('')
    expect(screen.getByTestId('location').textContent).toBe(`/card/${card.id}`)
  })
})

describe('the arm belongs to one card', () => {
  it('moving on to another card does not carry it over', async () => {
    const a = makeCard({ risk: 'high' })
    const b = makeCard({ risk: 'high' })
    armCard(a.id)
    const client = setup({ cards: [a, b] })
    fakeClock()
    renderWith(<CardDeepLink />, client, `/card/${b.id}`, '/card/:id')
    const button = screen.getByRole('button', { name: /Send/ })
    await pastArmDelay()
    expect(document.activeElement).not.toBe(button)
    expect(sent(client)).toHaveLength(0)
  })

  it('a spent arm stays spent: a second view of the same card later is not armed', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    fakeClock()
    const first = open(card, client)
    await pastArmDelay()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Send/ }))
    first.unmount()
    renderWith(<CardDeepLink />, client, `/card/${card.id}`, '/card/:id')
    const button = screen.getByRole('button', { name: /Send/ })
    await pastArmDelay()
    expect(document.activeElement).not.toBe(button)
    expect(sent(client)).toHaveLength(0)
  })

  it('an arm older than two minutes lapses', async () => {
    const card = makeCard({ risk: 'high' })
    const client = setup({ cards: [card] })
    fakeClock()
    armCard(card.id, Date.now() - 121_000)
    open(card, client, '', false)
    const button = screen.getByRole('button', { name: /Send/ })
    await pastArmDelay()
    expect(document.activeElement).not.toBe(button)
    expect(sent(client)).toHaveLength(0)
  })
})
