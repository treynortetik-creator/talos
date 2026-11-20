// Second round of push regression tests, web side. Each test pins a bug that was found and fixed, unless its name says
// "control". These mount the real
// App and its real routes, because arm.test.tsx mounts CardDeepLink on a private route and production never reaches that.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cardSend, makeCard } from '../cards/helpers.tsx'

async function open(url: string, card: ReturnType<typeof makeCard>, arm = false) {
  window.history.pushState({}, '', url)
  const { App } = await import('../../src/App.tsx')
  const { createFakeClient } = await import('../../src/lib/fakeClient.ts')
  const { createMemoryStorage } = await import('../../src/lib/storage.ts')
  const client = createFakeClient()
  client.store.setState((s) => ({ ...s, cards: [card] }))
  const resolve = vi.spyOn(client, 'resolveCard')
  if (arm) (await import('../../src/features/cards/arm.tsx')).armCard(card.id)
  render(<App client={client} storage={createMemoryStorage()} />)
  // The card is on screen first, so a failure below is about arming, not about this harness.
  const button = await cardSend()
  return { button, resolve }
}

describe('I5-R1 the Approve button through the real routes (IOS-SPEC 6.4)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_FAKE', '1')
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    Element.prototype.scrollIntoView = () => {} // jsdom has none; Timeline scrolls to the highlighted card
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it('R1 Approve on a live high-risk card focuses its button and sends nothing (no passkey: the tap in the app approves)', async () => {
    const card = makeCard({ risk: 'high' })
    const { button, resolve } = await open(`/card/${card.id}`, card, true)
    await waitFor(() => expect(document.activeElement).toBe(button))
    await new Promise((r) => setTimeout(r, 600))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('R1 Approve on any other card focuses its button and sends nothing', async () => {
    const card = makeCard({ risk: 'low' })
    const { button, resolve } = await open(`/card/${card.id}`, card, true)
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('R1 a URL carrying ?arm=primary starts nothing (a link in agent text cannot arm a card)', async () => {
    const card = makeCard({ risk: 'high' })
    const { button, resolve } = await open(`/card/${card.id}?arm=primary`, card)
    await new Promise((r) => setTimeout(r, 600))
    expect(document.activeElement).not.toBe(button)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('control: Open (no arm) on a high-risk card starts nothing', async () => {
    const card = makeCard({ risk: 'high' })
    const { button, resolve } = await open(`/card/${card.id}`, card)
    await new Promise((r) => setTimeout(r, 600))
    expect(document.activeElement).not.toBe(button)
    expect(resolve).not.toHaveBeenCalled()
  })
})
