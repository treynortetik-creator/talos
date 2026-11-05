// PR #82 review: the "Needs you" badge must drop a card when it expires, the way Home's tab does (useNow, 30 s).
// useNeedsYouCount memoises `Date.now()` on the `cards` array, so a card that expires while nothing touches `cards`
// keeps the badge, the tab title and the thread pill at 1 while Home says "Needs you (0)".
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BottomBar } from '../../src/features/threads/Nav.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { makeCard, renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

const soon = () => makeCard({ title: 'Soon', expires_at: '2026-10-31T12:00:05.000Z' })

describe('needs-you count after a card expires', () => {
  it('the bottom-bar badge clears within a minute of the only card expiring', async () => {
    renderWith(<BottomBar />, setup({ cards: [soon()] }))
    expect(screen.getByRole('img', { name: '1 need you' })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.queryByRole('img', { name: /need you/ })).toBeNull()
  })

  it('the badge clears once a message arrives after the expiry (the store changed, `cards` did not)', async () => {
    const client = setup({ cards: [soon()] })
    renderWith(<BottomBar />, client)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
      client.store.setState((s) => ({ ...s, lastSeq: (s.lastSeq ?? 0) + 1 }))
    })
    expect(screen.queryByRole('img', { name: /need you/ })).toBeNull()
  })

  it('the thread pill clears within a minute of the card expiring', async () => {
    renderWith(<ThreadScreen />, setup({ cards: [soon()] }), '/t/general', '/t/:thread')
    expect(screen.getByText(/1 needs you$/)).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.queryByText(/needs you$/)).toBeNull()
  })
})
