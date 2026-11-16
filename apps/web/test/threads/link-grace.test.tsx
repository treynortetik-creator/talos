// A short drop of the relay link, or of the Mac, shows nothing (owner, 2026-11-15: "it flashes on and off pretty regularly");
// one that lasts LINK_DOWN_GRACE_MS says so (lib/linkShown.ts). Sending still reads the real state.
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { LINK_DOWN_GRACE_MS, resetLinkShownForTests, setLinkGraceForTests } from '../../src/lib/linkShown.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => {
  resetLinkShownForTests()
  setLinkGraceForTests(LINK_DOWN_GRACE_MS)
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  setLinkGraceForTests(0)
})

const offlineLine = /You're offline|Can't reach your server/

describe('a drop of the relay link', () => {
  it('shorter than the grace shows nothing at all; a longer one says so once it has lasted that long', async () => {
    const client = setup({})
    renderWith(<Banners />, client, '/t/general', '/t/:thread')
    act(() => client.store.setState((s) => ({ ...s, connection: 'unreachable' })))
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_GRACE_MS - 5_000)
    })
    expect(screen.queryByText(offlineLine)).toBeNull()
    // back inside the window: nothing was ever shown
    act(() => client.store.setState((s) => ({ ...s, connection: 'online' })))
    act(() => client.store.setState((s) => ({ ...s, connection: 'unreachable' })))
    act(() => {
      vi.advanceTimersByTime(LINK_DOWN_GRACE_MS - 1_000)
    })
    expect(screen.queryByText(offlineLine)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByText(offlineLine)).toBeTruthy()
  })
})
